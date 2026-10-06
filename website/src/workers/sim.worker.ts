/// <reference lib="webworker" />

import type { CatalogBody } from "../lib/catalog";
import type { CatalogRequest, ConfigureRequest, DashboardSchema, SimRequest, SimResponse } from "../lib/protocol";
import { createGoHelpers, createLibcudart, getNumberWasmFunction, instantiateHostModule } from "../lib/libcudart";
import { simulationResponse, simulationResponseWithForwarding } from "../lib/partialTelemetry";
import { createMetricsStream } from "../lib/metricsStream";
import { finalizeRun, readExport, readExportError, readTelemetry } from "../lib/telemetryReads";
import type { GoInstance, GoRuntime, HostInstance } from "../lib/libcudart";

type WorkerScope = {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  location: Location;
};

type GoRuntimeConstructor = new () => GoRuntime;

const worker = self as unknown as WorkerScope;
const decoder = new TextDecoder();

function assetUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}${path}`, worker.location.origin).toString();
}

async function loadWasmExec(): Promise<void> {
  if ((globalThis as { Go?: GoRuntimeConstructor }).Go) return;
  const wasmExecUrl = assetUrl("wasm_exec.js");
  await import(/* @vite-ignore */ wasmExecUrl);
  tapRuntimeOutput();
}

// Where the Go runtime's own output goes, and why it has to be intercepted.
//
// wasm_exec routes EVERY byte the Go program writes -- stdout and stderr alike,
// through one object it creates only if nothing has: globalThis.fs.writeSync,
// which console.logs. So a panic message and a forty-line stack trace end up in
// the browser's developer console, which a learner reading the playground has never
// opened, and the run silently stops without saying why.
//
// The wrapper is installed after the import rather than by defining globalThis.fs
// first. Defining it first is the more obvious way to own the output, and it means
// reimplementing enough of the fs surface for the Go runtime to start at all --
// every method it might call, of which writeSync is the one anybody uses. Wrapping
// what wasm_exec built keeps that surface wasm_exec's problem and leaves this a
// function that forwards and returns.
//
// Lines are reassembled here rather than posted per write: the runtime writes a
// panic in many small pieces, and one console entry per piece would be unreadable.
// The fd is honoured even though wasm_exec ignores it, because it is the only thing
// distinguishing a panic (stderr) from ordinary output (stdout).
function tapRuntimeOutput(): void {
  const fs = (globalThis as { fs?: { writeSync?: (fd: number, buf: Uint8Array) => number } }).fs;
  const writeSync = fs?.writeSync;
  // Guarded because this runs once per worker but a second module would find the
  // wrapper already in place, and double-wrapping would post every line twice.
  if (fs === undefined || typeof writeSync !== "function" || tapped.has(fs)) return;
  tapped.add(fs);

  let partial = "";
  fs.writeSync = (fd: number, buf: Uint8Array): number => {
    partial += decoder.decode(buf);
    const lines = partial.split("\n");
    // The last element is whatever followed the final newline: empty when the write
    // ended one, and a partial line otherwise. It stays here until the rest arrives.
    partial = lines.pop() ?? "";
    for (const line of lines) post({ type: "simulator-output", kind: fd === 2 ? "stderr" : "stdout", text: line });
    return writeSync.call(fs, fd, buf);
  };
}

// The fs objects already wrapped, keyed by identity rather than guarded by a
// boolean: the point is that wrapping twice would post every line twice, and a
// per-object key says exactly that -- this object is done, a different one is not --
// without claiming to know how many fs objects a given Go version makes.
const tapped = new WeakSet<object>();

function post(message: SimResponse): void {
  worker.postMessage(message);
}

// A live module: the Go runtime, the instance it was started on, and its exports.
type PendingRun = {
  go: GoRuntime;
  instance: GoInstance;
  exports: Record<string, WebAssembly.ExportValue>;
};

// The instance a RUN may use: the one startup instantiated, consumed by the first
// run and never handed back, so every run from the second onward starts from a
// module that has not already been configured. It has to be consumed rather than
// reused because configure is one-shot per Go instance -- handing a configured
// instance to the next run gets "configure must be called before loadCodeObject".
let pending: PendingRun | null = null;

// The instance a CATALOG READ may use, which is a different question and a
// different instance. The export builds a local harness and frees it, so it reads
// correctly on any live module including one that has already run a kernel -- but
// only a live one, and after a run the run-only instance above has been handed on.
// Held separately for that reason: sharing one field would mean the second run of a
// session started on the module the first one used.
let readable: PendingRun | null = null;

// The run in flight, or null. Set for the whole of run() and cleared after it,
// because the export a catalog request makes builds a platform on this thread and
// must not do that while a simulation is occupying it.
let running: SimRequest | null = null;

// Set when the Go runtime stopped with a non-zero code, which is what a panic on a
// goroutine the harness does not own looks like from here: the export that caused
// it cannot recover a panic on the driver's engine goroutine, so the runtime prints
// the stack and exits. wasm_exec deletes the instance's exports on the way out, and
// every later call reads garbage rather than failing -- one probe read a status of
// 12795808 out of a call that should have returned 0 or 1 -- so a module in this
// state must never be posted to again.
let crashed = false;

// instantiate builds the Go module, wires the metrics import, starts the runtime,
// and returns the exports. Lifted out of run() so the catalog can
// be read before a run exists.
//
// env.pushMetrics is a wasm IMPORT, so it must be on the import object at
// instantiation and before go.run() begins. wasm resolves imports at
// INSTANTIATION and a missing one is a hard failure there rather than a nil call
// later, which is why every consumer of this binary supplies one -- this worker,
// both smoke scripts and the test harness.
//
// The callback needs the instance's memory, which does not exist until the
// instantiate call returns, so it reads it through a holder -- and it is built
// by createMetricsStream rather than written inline, because that is also
// what the test harnesses supply: a closure written here could not be driven by
// a test.
//
// The export is `mem`, NOT `memory`: Go 1.21 removed the memory export, so reading
// `memory` throws a TypeError inside the callback that unwinds the whole
// simulation.
async function instantiate(): Promise<PendingRun> {
  await loadWasmExec();
  const GoRuntimeConstructor = (globalThis as { Go?: GoRuntimeConstructor }).Go;
  if (!GoRuntimeConstructor) throw new Error("Go runtime is not available");
  const go = new GoRuntimeConstructor();
  // The runtime's death, reported. wasm_exec's own handler console.warns, which is
  // the same invisible place as the panic text; this posts it, and marks the module
  // dead so the next request is refused rather than posted into an instance whose
  // exports no longer exist.
  //
  // Set before go.run(), which is where the default lives, and per instance rather
  // than once: each instantiate() makes its own Go runtime, so a handler installed
  // on the first would not be this module's.
  go.exit = (code: number): void => {
    if (code === 0) return;
    crashed = true;
    pending = null;
    readable = null;
    post({ type: "crash", code });
  };
  const simBytes = await (await fetch(assetUrl("sim-runner.wasm"))).arrayBuffer();
  let goMemory: WebAssembly.Memory | null = null;
  const baseImport = go.importObject as { env?: Record<string, WebAssembly.ImportValue> };
  const goInstantiation = await WebAssembly.instantiate(simBytes, {
    ...baseImport,
    env: {
      ...baseImport.env,
      pushMetrics: createMetricsStream({
        memory: () => goMemory,
        onMetrics: (sample) => post({ type: "metrics", metrics: sample }),
        // An unreadable body goes to the Console rather than being dropped: the
        // callback's whole job is a pointer crossing into JavaScript, so a failure
        // here is a bridge defect the reader should be able to see.
        onUnreadable: (message) => post({ type: "stdout", text: `${message}\n` }),
      }),
    },
  }) as WebAssembly.WebAssemblyInstantiatedSource;
  const goInstance = goInstantiation.instance as GoInstance;
  goMemory = goInstance.exports.mem;
  // Started here rather than in run(), because the catalog read at the bottom of
  // this file needs a live module and App only posts a run request after the
  // `ready` below. The rejection handler stays with the go.run() call, which is the
  // only place the promise exists.
  const goRun = go.run(goInstance);
  void goRun.catch((error: unknown) => post({ type: "error", message: String(error) }));
  return { go, instance: goInstance, exports: goInstance.exports };
}

// readCatalog asks the export what the simulator is.
//
// configure has NOT been called yet, which is the order the browser depends on: the
// export reads the catalog through harness.CatalogFor, which builds a LOCAL harness
// and never assigns the package-level h, so this instance stays configurable and run
// 1 can use it. Routing it through ensureHarness() + h.Catalog() instead assigns h,
// configure then refuses, and run 1 fails -- which is why
// simulator/scripts/sim-smoke.mjs asserts the order.
//
// device names the device whose figures to read. The export builds that device's
// platform to read them, which is why it is a parameter and not a constant: every
// other registry device is listed either way, and asking for one costs one
// platform. An empty name reads the registry default, which is what the page-load
// read wants -- it must not name a device, because the page has not chosen one.
//
// The export's return is a status on the failure path, not a length, so it is
// checked against the buffer's length rather than for > 0: a plain length test lets
// a failure through to JSON.parse, and the message then surfaces without the status
// saying which hop failed.
function readCatalog(pendingRun: PendingRun, device: string): { body: CatalogBody | null; error?: string } {
  // One helpers object for both halves rather than a goRead() call per use,
  // because the write has to land in the same memory the export reads from. An
  // empty name is written as a null pointer, which is what the Go side sees as ""
  // and resolves to the registry default.
  const { goRead, goWrite } = createGoHelpers(pendingRun.instance);
  try {
    const name = new TextEncoder().encode(device);
    const namePtr = name.length === 0 ? 0 : goWrite(name);
    const status = getNumberWasmFunction(pendingRun.exports, "catalog")(namePtr, name.length);
    const ptr = getNumberWasmFunction(pendingRun.exports, "resultPtr")();
    const buffered = getNumberWasmFunction(pendingRun.exports, "resultLen")();
    if (status <= 0 || ptr === 0) return { body: null, error: "the catalog export returned no data" };
    if (status !== buffered) {
      return { body: null, error: `catalog export failed (status ${status}): ${decoder.decode(goRead(ptr, buffered))}` };
    }
    return { body: JSON.parse(decoder.decode(goRead(ptr, status))) as CatalogBody };
  } catch (error: unknown) {
    const reason = readExportError(pendingRun.exports, goRead);
    return { body: null, error: reason ?? String(error) };
  }
}

async function run(request: SimRequest): Promise<void> {
  // The startup instance, if one is still held; consumed here and the field
  // cleared, so every run from the second onward starts from a module nothing has
  // touched. It is handed back at the end of the run below, which is what keeps a
  // catalog request answerable afterwards.
  const reuse = pending;
  pending = null;
  const active = reuse ?? await instantiate();
  const { go, instance: goInstance, exports } = active;
  try {
    await simulate(active, request);
  } finally {
    // Offered to catalog reads, which need a live module and can use this one: it
    // is not configurable, but a catalog read reads no run configuration.
    readable = active;
  }
}

async function simulate(active: PendingRun, request: SimRequest): Promise<void> {
  const { go, instance: goInstance, exports } = active;

  const { goWrite, goRead } = createGoHelpers(goInstance);
  const configure = getNumberWasmFunction(exports, "configure");
  const loadCodeObject = getNumberWasmFunction(exports, "loadCodeObject");
  // A Go string reaches wasm as a (pointer, length) pair, so the device name has to
  // be written into Go memory; hipLaunchKernel in libcudart.ts does the same for the
  // kernel name.
  // A rejected configure reaches the learner with the simulator's own words rather
  // than a bare "configure failed".
  const exportFailure = (name: string): Error =>
    new Error(readExportError(exports, goRead) ?? `${name} failed`);
  const deviceName = new TextEncoder().encode(request.device);
  const deviceNamePtr = goWrite(deviceName);
  // The Customize sizes, as the i32 the export takes. Absent fields become 0,
  // which the simulator reads as "leave the device default alone" -- see the
  // SimOverrides comment for why absence and zero have to be the same thing here.
  const o = request.overrides ?? {};
  if (configure(
    request.maxInst,
    deviceNamePtr,
    deviceName.length,
    o.l1vBytes ?? 0,
    o.l2Bytes ?? 0,
    o.mallBytes ?? 0,
    o.memoryBytes ?? 0,
  ) !== 0) throw exportFailure("configure");
  const codeObjectPtr = goWrite(new Uint8Array(request.deviceCodeObject));
  if (loadCodeObject(codeObjectPtr, request.deviceCodeObject.byteLength) !== 0) throw exportFailure("loadCodeObject");

  // How this run's stream should be drawn, read HERE and posted before main()
  // runs: the harness exists as soon as loadCodeObject has called ensureHarness, so
  // this is the first moment the schema describes the platform this run will use.
  //
  // Read once per run rather than alongside each sample because it is a
  // DESCRIPTION of the device, not a measurement of the kernel -- the same body for
  // every sample of the run, and re-reading it 25 times a second would be a cost
  // paid for an answer that cannot change mid-run.
  //
  // A missing export degrades to no schema rather than failing the run: the
  // finished telemetry body is the authoritative result and this is a readout, so
  // trading a real result for a cosmetic one is the wrong direction. The Dashboard
  // renders nothing without a schema, which is honest -- it is what a browser
  // talking to a pre-schema simulator can say.
  const schemaRead = readExport(exports, goRead, "dashboardSchema");
  if (schemaRead.value !== null) {
    post({ type: "dashboard-schema", schema: schemaRead.value as DashboardSchema });
  } else if (exports.dashboardSchema == null) {
    post({ type: "stdout", text: "This simulator build has no dashboardSchema export, so the live dashboard cannot be drawn.\n" });
  }

  const onStdout = (bytes: Uint8Array): void => {
    const ptr = goWrite(bytes);
    if (getNumberWasmFunction(exports, "writeStdout")(ptr, bytes.length) !== 0) {
      throw new Error("writeStdout failed");
    }
    post({ type: "stdout", text: decoder.decode(bytes) });
  };
  const hostReference: HostInstance = { exports: { memory: null } };
  // A fresh bridge for every run, so nothing one run records can reach the next: no
  // kernel registration, no launched-kernel list, no pending launch configuration.
  const libcudart = createLibcudart({ go, goInstance, hostInstance: hostReference, onStdout });
  const hostInstance = await instantiateHostModule(request.hostWasm, libcudart, hostReference, onStdout);
  const main = getNumberWasmFunction(hostInstance.exports, "main");
  const status = main(0, 0);
  const bridgeError = libcudart.getInternalError();
  // The program's main has returned, so the run is over: drain here, which also
  // emits the final live sample. Without it the last point on every chart is
  // whichever paced sample happened to be last, and host work after the program's
  // final cudaDeviceSynchronize -- a cudaFree, a late cudaMalloc -- never reaches
  // the panel at all. See finalizeRun.
  const finished = finalizeRun(goInstance.exports as unknown as Record<string, WebAssembly.ExportValue>);
  const telemetryRead = readTelemetry(exports, goRead);
  // A drain that failed is a run that did not finish, so it is reported alongside
  // the other failures rather than dropped. drained === 1 without an error is the
  // instruction budget stopping the run, which the telemetry body already reflects.
  const runError = bridgeError || finished.error;
  const response = simulationResponse(status, runError, telemetryRead.telemetry, telemetryRead.errors);
  const forwardedResponse = await simulationResponseWithForwarding(
    response,
    telemetryRead.telemetry,
    {
      metrics: import.meta.env.VITE_OTLP_METRICS_ENDPOINT,
    },
  );
  post(forwardedResponse);
}

// catalogRequest answers a catalog read for one device.
//
// The instance it reads on is `readable`: the startup one, or -- because run()
// offers its instance there -- the one the last run used. Either way a catalog
// read builds a LOCAL harness and frees it, so it cannot consume the instance a
// run will use or leave it configured.
//
// Reading while a run is in flight is refused rather than queued: the export
// builds a whole platform on the thread the simulation is running on, and a
// device whose figures are a second late is not worth stalling a kernel for. The
// page asks again the moment the run is over.
function catalogRequest(request: CatalogRequest): void {
  if (crashed) {
    post({ type: "catalog", body: null, error: "the simulator stopped after a crash" });
    return;
  }
  if (readable === null) {
    post({ type: "catalog", body: null, error: "the simulator is not loaded yet" });
    return;
  }
  if (running !== null) {
    post({ type: "catalog", body: null, error: "a run is in progress" });
    return;
  }
  post({ type: "catalog", ...readCatalog(readable, request.device) });
}

// applyConfiguration validates and saves a new set of sizes, discarding the built
// platform so the next run is constructed from them.
//
// Refused while a run is in flight, for the same reason catalogRequest is: the
// export tears the harness down, and doing that under a live simulation would take
// the platform out from under it. The page disables the button for the duration, so
// reaching here mid-run means the page and the worker disagree about the state.
function applyConfiguration(request: ConfigureRequest): void {
  if (crashed) {
    post({ type: "configured", body: null, error: "the simulator stopped after a crash" });
    return;
  }
  if (running !== null) {
    post({ type: "configured", body: null, error: "a run is in flight" });
    return;
  }
  const target = readable;
  if (target === null) {
    post({ type: "configured", body: null, error: "the simulator is not ready yet" });
    return;
  }
  const { goRead } = createGoHelpers(target.instance);
  const o = request.overrides ?? {};
  const status = getNumberWasmFunction(target.exports, "applyConfiguration")(
    o.l1vBytes ?? 0,
    o.l2Bytes ?? 0,
    o.mallBytes ?? 0,
    o.memoryBytes ?? 0,
  );
  if (status !== 0) {
    post({
      type: "configured",
      body: null,
      error: readExportError(target.exports, goRead) ?? "the simulator refused these sizes",
    });
    return;
  }
  // The catalog is re-read HERE rather than left to the page's next request: the
  // point of saving is that the figures change, and a reader who saved a size and
  // saw the old number still on screen would conclude it had been ignored.
  post({ type: "configured", ...readCatalog(target, "") });
}

worker.onmessage = (event: MessageEvent<unknown>) => {
  const request = event.data as { type?: string };
  if (request?.type === "catalog-request") {
    catalogRequest(event.data as CatalogRequest);
    return;
  }
  if (request?.type === "configure") {
    applyConfiguration(event.data as ConfigureRequest);
    return;
  }
  if (request?.type !== "run") {
    post({ type: "error", message: "unsupported worker request" });
    return;
  }
  // Refused rather than attempted. The instance a crashed runtime leaves behind has
  // no exports, so a run posted to it reads whatever is at those addresses and
  // reports it as a status: the page would show a compile that succeeded and a
  // simulation that failed for no visible reason. The page gets the truth instead,
  // and starts a fresh worker for the next run.
  if (crashed) {
    post({ type: "error", message: "the simulator stopped after a crash; reload the page to run another kernel" });
    return;
  }
  const active = event.data as SimRequest;
  running = active;
  run(active)
    .catch((error: unknown) => post({ type: "error", message: String(error) }))
    .finally(() => { running = null; });
};

// At module load: instantiate, read the catalog off that instance, post it, then
// post ready. A failure is reported in the catalog message rather than thrown, so
// ready still follows and whatever awaits it is not left waiting on a dead worker.
//
// The read names no device: the page has not chosen one yet, and the export would
// spend a platform build on whichever device is named, so the default is the right
// one to pay for here.
instantiate()
  .then((pendingRun) => {
    const read = readCatalog(pendingRun, "");
    pending = pendingRun;
    readable = pendingRun;
    post({ type: "catalog", ...read });
    post({ type: "ready" });
  })
  .catch((error: unknown) => {
    post({ type: "catalog", body: null, error: String(error) });
    post({ type: "ready" });
  });
