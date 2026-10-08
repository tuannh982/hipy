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

let pending: PendingRun | null = null;

let readable: PendingRun | null = null;

let running: SimRequest | null = null;

let crashed = false;

async function instantiate(): Promise<PendingRun> {
  await loadWasmExec();
  const GoRuntimeConstructor = (globalThis as { Go?: GoRuntimeConstructor }).Go;
  if (!GoRuntimeConstructor) throw new Error("Go runtime is not available");
  const go = new GoRuntimeConstructor();
                  go.exit = (code: number): void => {
    if (code === 0) return;
    crashed = true;
    pending = null;
    readable = null;
    post({ type: "crash", code });
  };
  const simBytes = await (await fetch(assetUrl("sim-runner.wasm.br"))).arrayBuffer();
  let goMemory: WebAssembly.Memory | null = null;
  const baseImport = go.importObject as { env?: Record<string, WebAssembly.ImportValue> };
  const goInstantiation = await WebAssembly.instantiate(simBytes, {
    ...baseImport,
    env: {
      ...baseImport.env,
      pushMetrics: createMetricsStream({
        memory: () => goMemory,
        onMetrics: (sample) => post({ type: "metrics", metrics: sample }),
                                onUnreadable: (message) => post({ type: "stdout", text: `${message}\n` }),
      }),
    },
  }) as WebAssembly.WebAssemblyInstantiatedSource;
  const goInstance = goInstantiation.instance as GoInstance;
  goMemory = goInstance.exports.mem;
          const goRun = go.run(goInstance);
  void goRun.catch((error: unknown) => post({ type: "error", message: String(error) }));
  return { go, instance: goInstance, exports: goInstance.exports };
}

function readCatalog(pendingRun: PendingRun, device: string): { body: CatalogBody | null; error?: string } {
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
            const exportFailure = (name: string): Error =>
    new Error(readExportError(exports, goRead) ?? `${name} failed`);
  const deviceName = new TextEncoder().encode(request.device);
  const deviceNamePtr = goWrite(deviceName);
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
            const finished = finalizeRun(goInstance.exports as unknown as Record<string, WebAssembly.ExportValue>);
  const telemetryRead = readTelemetry(exports, goRead);
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
