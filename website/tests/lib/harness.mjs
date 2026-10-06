// Compiles one .cu with the pinned toolchain and runs it in the wasm simulator.
//
// The e2e path in one place: compile.sh runs the pinned clang for the requested arch
// and emits host.wasm plus device.co, the simulator loads the code object, and the
// host module's main() runs against it. Nothing is stubbed, so a kernel using an
// instruction the emulator cannot execute fails here rather than passing.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { readExportError, finalizeRun } from "../../src/lib/telemetryReads.ts";

const execFileAsync = promisify(execFile);

export const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
export const fixturesDir = path.join(repoRoot, "website", "tests", "fixtures");

// Device name -> the ISA its registry entry names, the same join
// simulator/harness/device.go's TargetArch makes. Written out rather than read
// from device.go on purpose. Scraping device.go would derive the arch from the
// registry, and a device whose entry is wrong -- a typo, a gfx name no toolchain
// emits -- would then be compiled for whatever the registry claims and fail as a
// simulator panic instead of as a compile error. Here a wrong entry is wrong in the
// one place a reader can see it.
//
// This is the whole per-device knowledge the suite has, and tests/toolchain.test.mjs
// asserts it agrees with toolchain/toolchains.json, which simulator/harness's own
// TestToolchainRegistryAgrees ties to device.go. So a device added to the registry
// without being wired up here cannot quietly shrink the suite's coverage.
const DEVICE_ARCH = { gcn3generic: "gfx803", cdna3generic: "gfx942" };

// Every device the correctness suite must cover: the selectable ones, DERIVED from
// DEVICE_ARCH rather than written beside it. Two independent literals is how a
// device gets added to one and not the other, which halves the coverage with every
// test still green -- and it cannot be added here without an arch, so a device that
// reaches this file is a device the suite runs.
export const SELECTABLE_DEVICES = Object.keys(DEVICE_ARCH).sort();

/** The arch a device's toolchain must emit for it; throws on an unknown name. */
export function deviceArch(device) {
  const arch = DEVICE_ARCH[device];
  if (!arch) throw new Error(`unknown device ${JSON.stringify(device)}; known devices: ${Object.keys(DEVICE_ARCH).join(", ")}`);
  return arch;
}

const DEFAULT_DEVICE = "gcn3generic";

/**
 * The (arch, device) pair a run must use.
 *
 * `arch` and `device` name the same thing from two sides -- the ISA the toolchain
 * emitted and the platform MGPUSim builds -- and nothing downstream range-checks
 * the match, so a caller that supplied only one got a code object run under a
 * different GPU with no error anywhere. So neither is defaulted independently: each
 * is derived from the other, and a disagreement is an error rather than a
 * preference. Naming neither is the one case that falls back to the registry default.
 *
 * An arch no device builds for is returned with a null device rather than refused.
 * That is compile.sh's to refuse, and refusing here would replace the toolchain
 * suite's check of what the compiler does with an unknown target with a check of
 * this file's own arithmetic.
 */
export function resolveTarget({ arch, device } = {}) {
  if (device !== undefined) {
    const expected = deviceArch(device);
    if (arch !== undefined && expected !== arch) {
      throw new Error(`device ${device} is ${expected}, not ${arch}: the code object and the platform it runs on would disagree`);
    }
    return { arch: expected, device };
  }
  if (arch !== undefined) {
    return { arch, device: SELECTABLE_DEVICES.find((name) => DEVICE_ARCH[name] === arch) ?? null };
  }
  return { arch: DEVICE_ARCH[DEFAULT_DEVICE], device: DEFAULT_DEVICE };
}

const decode = new TextDecoder();
const encoder = new TextEncoder();

function paths() {
  const publicDir = path.join(repoRoot, "website", "public");
  return {
    compileScript: path.join(repoRoot, "toolchain", "src", "scripts", "compile.sh"),
    simulatorWasm: process.env.SIM_WASM ?? path.join(publicDir, "sim-runner.wasm"),
    wasmExec: process.env.SIM_WASM_EXEC ?? path.join(publicDir, "wasm_exec.js"),
  };
}

// What has to exist before anything can be compiled or simulated. Returned as a list
// so a skipped suite names the build step that is missing.
export function missingPrerequisites() {
  const { simulatorWasm, wasmExec } = paths();
  const driver = path.join(repoRoot, "toolchain", "artifacts", "llvm-driver.wasm");
  const missing = [];
  if (!existsSync(driver)) missing.push(`${driver} (run: make -C toolchain llvm)`);
  if (!existsSync(simulatorWasm)) missing.push(`${simulatorWasm} (run: make -C simulator wasm)`);
  if (!existsSync(wasmExec)) missing.push(`${wasmExec} (run: make -C simulator wasm)`);
  return missing;
}

let bridge = null;

async function loadBridge() {
  if (bridge) return bridge;
  const { wasmExec } = paths();
  await import(pathToFileURL(wasmExec).href);
  const { createGoHelpers, createLibcudart, instantiateHostModule } =
    await tsImport(path.join(repoRoot, "website", "src", "lib", "libcudart.ts"), import.meta.url);
  const { createMetricsStream } =
    await tsImport(path.join(repoRoot, "website", "src", "lib", "metricsStream.ts"), import.meta.url);
  bridge = { createGoHelpers, createLibcudart, createMetricsStream, instantiateHostModule };
  return bridge;
}

// What compile() records next to host.wasm and device.co so runArtifact, which only
// sees a directory, can check the ISA against the platform it is about to configure.
// A caller that compiles for one device and runs on another gets a code object the
// emulator executes under the wrong ALU with no error, so the pair travels with the
// artifact instead of being threaded through the caller.
const TARGET_FILE = "hipy-target.json";

/** Compile `sourcePath`; returns the artifact directory, its target, and a cleanup. */
export async function compile(sourcePath, options = {}) {
  const { compileScript } = paths();
  const target = resolveTarget(options);
  const { toolchainId = "amdgcn" } = options;
  const artifactDir = await mkdtemp(path.join(tmpdir(), "hipy-test-"));
  try {
    await execFileAsync(compileScript, [sourcePath, artifactDir, target.arch, toolchainId], { maxBuffer: 64 * 1024 * 1024 });
    await writeFile(path.join(artifactDir, TARGET_FILE), JSON.stringify(target));
  } catch (error) {
    await rm(artifactDir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir: artifactDir,
    ...target,
    read: (name) => readFile(path.join(artifactDir, name)),
    cleanup: () => rm(artifactDir, { recursive: true, force: true }),
  };
}

/**
 * Run an already-compiled artifact directory. Returns { stdout, values, codeObject,
 * bridgeError, drained, lds }: stdout as text, values as every number on a line
 * without an "=", codeObject as the device code object the run loaded, and the LDS
 * bank analysis the harness exported.
 */
export async function runArtifact(artifactDir, options = {}) {
  const { simulatorWasm } = paths();
  // 0 is the harness's "no cutoff": a cap here would quietly truncate a long fixture
  // into a partial result that assertMatchesCpu then reports as a wrong value.
  const { maxInstructions = 0, wantLds = false } = options;
  const { createGoHelpers, createLibcudart, createMetricsStream, instantiateHostModule } = await loadBridge();
  const hostWasm = await readFile(path.join(artifactDir, "host.wasm"));
  const codeObject = await readFile(path.join(artifactDir, "device.co"));

  // The device compile() actually built for, and an explicit device that disagrees
  // with it. A directory with no record -- one a caller assembled by hand -- falls
  // back to the registry default, which is what the suites that are not
  // device-parameterised want.
  let recorded = null;
  try {
    recorded = JSON.parse(await readFile(path.join(artifactDir, TARGET_FILE), "utf8"));
  } catch {
    recorded = null;
  }
  const device = options.device ?? recorded?.device ?? DEFAULT_DEVICE;
  // Raises if the artifact's arch is not the one this device builds for.
  resolveTarget({ arch: recorded?.arch, device });

  const go = new globalThis.Go();
  // env.pushMetrics is a wasm IMPORT, so a missing one is a hard failure at
  // instantiation rather than a nil call later. This supplies the PRODUCTION
  // callback rather than a stub: the pointer it is handed arrives sign-extended, so
  // a no-op could not fail on a device whose heap crossed 2 GiB while the real one
  // would.
  const metricFailures = [];
  let metrics = 0;
  let lastSample = null;
  const allSamples = [];
  let goMemory = null;
  let instance;
  ({ instance } = await WebAssembly.instantiate(await readFile(simulatorWasm), {
    ...go.importObject,
    env: {
      ...(go.importObject?.env ?? {}),
      pushMetrics: createMetricsStream({
        memory: () => goMemory,
        onMetrics: (m) => { metrics++; lastSample = m; allSamples.push(m); },
        onUnreadable: (message) => metricFailures.push(message),
      }),
    },
  }));
  goMemory = instance.exports.mem;
  void go.run(instance).catch(() => {});
  const { goCall, goWrite, goRead } = createGoHelpers(instance);

  // The device is passed to configure, which hands it to WithGPUType: that is what
  // picks timingconfig's platform, so the device name and the compiled arch must
  // agree or the code object runs under the wrong GPU -- which resolveTarget above
  // has already established, against the arch compile() actually used.
  const deviceName = encoder.encode(device);
  // The four Customize sizes, defaulting to 0 = "the device's own default", which
  // is what the export documents and what the builders read a zero as.
  const o = options.overrides ?? {};
  if (goCall("configure", maxInstructions, goWrite(deviceName), deviceName.length,
    o.l1vBytes ?? 0, o.l2Bytes ?? 0, o.mallBytes ?? 0, o.memoryBytes ?? 0) !== 0) {
    throw new Error("configure failed");
  }
  const codePtr = goWrite(new Uint8Array(codeObject));
  if (goCall("loadCodeObject", codePtr, codeObject.length) !== 0) throw new Error("loadCodeObject failed");

  const chunks = [];
  const onStdout = (bytes) => {
    chunks.push(Buffer.from(bytes));
    const ptr = goWrite(bytes);
    if (goCall("writeStdout", ptr, bytes.length) !== 0) throw new Error("writeStdout failed");
  };
  const hostReference = { exports: { memory: null } };
  const bridgeLib = createLibcudart({ go, goInstance: instance, hostInstance: hostReference, onStdout });
  const hostInstance = await instantiateHostModule(hostWasm, bridgeLib, hostReference, onStdout);
  const status = hostInstance.exports.main(0, 0);
  if (status !== 0) throw new Error(`the program's main() returned ${status}`);

  const stdout = decode.decode(Buffer.concat(chunks));
  const values = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "" || text.includes("=")) continue;
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`unparseable output line ${JSON.stringify(text)}`);
    values.push(value);
  }

  // The stream ran for the whole of main() above, so this is where a body the callback
  // could not read is caught. A dropped sample must not fail a run -- the finished
  // body supersedes it -- but it must be visible.
  if (metricFailures.length > 0) {
    throw new Error(`the metrics callback could not read Go memory: ${metricFailures.join("; ")}`);
  }

  let lds = null;
  if (wantLds) {
    const length = goCall("ldsAnalysis");
    if (length > 0) lds = JSON.parse(decode.decode(goRead(goCall("resultPtr"), length)));
  }

  return {
    stdout,
    values,
    lds,
    // The code object this run loaded, so a caller can assert something about what
    // the toolchain emitted for this device rather than only about what it computed.
    codeObject,
    device,
    bridgeError: bridgeLib.getInternalError(),
    // How many samples arrived. Zero is legitimate for a kernel too short to cross
    // the flush stride, so this is reported rather than asserted on here;
    // tests/simulator.test.mjs requires it non-zero for a long enough workload.
    metrics,
    allSamples,
    instance,
    // 1 means the instruction budget stopped the run. A partial result must never be
    // compared against a full reference, so callers check this.
    //
    // The SAME function the worker calls once main() has returned, so the two paths
    // cannot disagree about what a drain did.
    drained: finalizeRun(instance.exports).drained,
    // Read AFTER the drain above: object properties evaluate in order, so reading
    // lastSample before it would miss the final sample the drain emits, which is
    // where the L2 write-back lands.
    lastSample: lastSample,
  };
}

/**
 * Save a new set of sizes and discard the built platform, the way the Customize
 * tab's "Save configuration" does.
 *
 * Calls applyConfiguration rather than configure because that is the export the
 * browser uses: configure refuses once a harness exists, and applyConfiguration is
 * what tears the old one down so the next run is built from the new sizes. A test
 * that went through configure would be testing a different path from the one in use.
 */
export async function applyConfiguration(instance, overrides = {}) {
  const { createGoHelpers } = await loadBridge();
  const { goCall, goRead } = createGoHelpers(instance);
  const status = goCall("applyConfiguration",
    overrides.l1vBytes ?? 0,
    overrides.l2Bytes ?? 0,
    overrides.mallBytes ?? 0,
    overrides.memoryBytes ?? 0);
  if (status !== 0) {
    throw new Error(readExportError(instance.exports, goRead) ?? "applyConfiguration failed");
  }
}

/**
 * Read the catalog off an existing instance, the way the worker does after a save.
 *
 * Separate from runArtifact because a save is followed by a catalog read and NOT by
 * a run: the point is to see the figures the saved sizes produce without paying for
 * another simulation.
 */
export async function catalogForInstance(instance, device) {
  const { createGoHelpers } = await loadBridge();
  const { goCall, goWrite, goRead } = createGoHelpers(instance);
  const name = encoder.encode(device);
  const status = goCall("catalog", goWrite(name), name.length);
  if (status <= 0) {
    throw new Error(`catalog export failed (status ${status}): ${decode.decode(goRead(goCall("resultPtr"), status))}`);
  }
  return JSON.parse(decode.decode(goRead(goCall("resultPtr"), status)));
}

/** Compile and run in one step. */
export async function compileAndRun(sourcePath, options = {}) {
  const artifact = await compile(sourcePath, options);
  try {
    // The device compile resolved, not the caller's: an option that named one side of
    // the pair has already been completed into both, and the artifact carries the
    // answer for runArtifact to check.
    return await runArtifact(artifact.dir, { ...options, device: artifact.device });
  } finally {
    await artifact.cleanup();
  }
}