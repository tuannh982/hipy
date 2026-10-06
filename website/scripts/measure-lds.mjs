// Measures one example's LDS conflict degrees through the real pipeline and prints
// them as a table. Degrees are computed by the analyzer from the access pattern; this
// prints what it computed and infers nothing from the source.
//
// Usage: node --import tsx scripts/measure-lds.mjs <artifactDir> <kernelName>
//
// Every step of the run is checked (the shape website/scripts/sim-smoke.mjs
// established): the host module produced an instance, the bridge reported no internal
// error, the named kernel was both registered and launched, the drain did not hit the
// instruction cutoff, and the metrics body is non-empty. A measurement
// tool that prints a table is a table someone will quote, so an incomplete or
// unverified run throws instead of printing.
//
// Deliberately NOT checked is how many times the named kernel was launched: there is
// no fixture manifest here to protect that invariant, a warmup launch is ordinary,
// and a .cu holding two kernels of which only the measured one is launched is a
// legitimate shape. Repeated launches of the named kernel are summed into one
// measurement; a kernel under measurement that nobody launched is still a failure.
//
// `sim-runner.wasm` is gitignored and built by `make -C simulator wasm`, so
// SIM_WASM and SIM_WASM_EXEC override where those two files are read from.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const artifactDir = process.argv[2];
const kernel = process.argv[3];
if (!artifactDir || !kernel) {
  console.error("usage: measure-lds.mjs <artifactDir> <kernelName>");
  process.exit(2);
}

const root = new URL("../", import.meta.url);
await import(pathToFileURL(new URL(process.env.SIM_WASM_EXEC ?? "public/wasm_exec.js", root).pathname).href);
const { createGoHelpers, createLibcudart, instantiateHostModule } =
  await import(new URL("src/lib/libcudart.ts", root).pathname);

const simBytes = await readFile(new URL(process.env.SIM_WASM ?? "public/sim-runner.wasm", root));
const decoder = new TextDecoder();

const go = new globalThis.Go();
// env.pushMetrics is a wasm IMPORT and wasm resolves imports at
// instantiation, so a missing one is a hard failure here rather than a nil call
// later. This tool measures LDS degrees and has no use for the live stream, so
// it supplies a sink that drops what arrives -- but it has to supply one.
const { instance } = await WebAssembly.instantiate(simBytes, {
  ...go.importObject,
  env: { ...(go.importObject?.env ?? {}), pushMetrics: () => {} },
});
void go.run(instance).catch(() => {});
const { goCall, goWrite, goRead } = createGoHelpers(instance);

// A wrong artifact directory is the most likely mistake, so name the directory and
// the two files rather than letting readFile surface a bare ENOENT.
const artifactPath = async (name) => {
  const path = `${artifactDir}/${name}`;
  try {
    return await readFile(path);
  } catch (error) {
    throw new Error(
      `no ${name} in ${artifactDir}: ${error.message}. Point the first argument at a directory holding the ` +
        `output of toolchain/src/scripts/compile.sh (device.co and host.wasm).`,
    );
  }
};
const device = await artifactPath("device.co");
const host = await artifactPath("host.wasm");
const stdoutChunks = [];
const hostReference = { exports: { memory: null } };
const bridge = createLibcudart({
  go,
  goInstance: instance,
  hostInstance: hostReference,
  onStdout: (bytes) => {
    stdoutChunks.push(new Uint8Array(bytes));
    const status = goCall("writeStdout", goWrite(new Uint8Array(bytes)), bytes.length);
    if (status !== 0) throw new Error(`writeStdout failed: ${status}`);
  },
});

// The Go string parameter reaches wasm as a (pointer, length) pair, so the device
// name is written into Go memory rather than passed as a string. 0 keeps this
// script on the inert default every other script and test here uses.
// This script runs a code object the caller already compiled, so it configures a
// device rather than choosing a target: no compiler flags are involved and the
// name only has to be one the simulator can build.
const { anyClaimedDevice } = await tsImport("../src/lib/toolchains.ts", import.meta.url);
const claimed = anyClaimedDevice();
if (claimed === null) throw new Error("toolchain/toolchains.json claims no device");
const deviceName = new TextEncoder().encode(claimed);
if (goCall("configure", 2_000_000, goWrite(deviceName), deviceName.length) !== 0) {
  throw new Error("configure failed");
}
if (goCall("loadCodeObject", goWrite(device), device.length) !== 0) throw new Error("loadCodeObject failed");
const hostInstance = await instantiateHostModule(host, bridge, hostReference, () => {});
if (!(hostInstance instanceof WebAssembly.Instance)) throw new Error("host module did not produce a WebAssembly.Instance");
if (hostInstance.exports.main(0, 0) !== 0) throw new Error("host main returned nonzero");

const bridgeError = bridge.getInternalError();
if (bridgeError) throw new Error(`bridge error: ${bridgeError}`);

// The kernel argument labels the table, so it has to name a kernel this artifact
// actually registered and actually launched. `kernel` is never otherwise read by
// the run, so without these three checks a wrong directory or a typo'd name
// yields a confidently labelled `patterns=0` table rather than a failure.
const registeredNames = bridge.getKernelRegistrations().map((registration) => registration.name);
const launchedNames = bridge.getLaunchedKernels().map((launched) => launched.name);
if (registeredNames.length === 0) throw new Error("host module registered no kernels");
if (!registeredNames.includes(kernel)) {
  throw new Error(`no kernel named ${kernel} is registered; registered kernels: ${JSON.stringify(registeredNames)}`);
}
if (!launchedNames.includes(kernel)) {
  throw new Error(`kernel ${kernel} was registered but never launched; launched kernels: ${JSON.stringify(launchedNames)}`);
}

// drain() returns 1 only when the simulator hit its MaxInst instruction cutoff
// (simulator/wasmexec/exports.go, the drain export). A cutoff is the one
// failure that still produces a well-formed, short, plausible table, so it has to
// stop the run here: everything printed below would be a partial sample. The
// analyzer's own `droppedExecutions` and `truncatedInstances` counters stay 0 on a
// truncated run -- they cap the analyzer, not the simulator -- so they cannot
// stand in for this signal.
const drained = goCall("drain");
if (drained !== 0) {
  throw new Error(
    `drain returned ${drained}: the simulator hit its MaxInst instruction cutoff, so this run stopped part way through ` +
      `the kernel and the table would be a partial sample of its LDS accesses rather than the whole population. ` +
      `stats.droppedExecutions and stats.truncatedInstances describe the analyzer's caps, not this cutoff, and are 0 here. ` +
      `Raise the instruction budget passed to configure and measure again.`,
  );
}

// Every export here returns the body length on success and exactly 1 on failure,
// with the Go error text left in the result buffer (wasmexec/exports.go's setError).
// So the length is checked before the decode, as website/scripts/sim-smoke.mjs does:
// JSON.parse on an empty body is a bare "Unexpected end of JSON input", and reading
// `len` bytes off a failed export would slice one byte of the error string and parse
// that instead. Both cases now say which export failed and why.
const exportBody = (name) => {
  const length = goCall(name);
  if (length <= 0) throw new Error(`${name} returned ${length}: empty body`);
  if (length === 1) {
    const errorLength = goCall("resultLen");
    const errorText = decoder.decode(goRead(goCall("resultPtr"), Math.max(errorLength, 0)));
    throw new Error(`${name} export failed: ${errorText || "no error text"}`);
  }
  return JSON.parse(decoder.decode(goRead(goCall("resultPtr"), length)));
};

const metrics = exportBody("metrics");
if (!Array.isArray(metrics.resourceMetrics) || metrics.resourceMetrics.length === 0) {
  throw new Error(`unexpected metrics body: ${JSON.stringify(metrics)}`);
}

const lds = exportBody("ldsAnalysis");
if (lds.patterns.length === 0) {
  throw new Error(
    `ldsAnalysis returned 0 patterns for ${kernel}, which was registered, launched, and produced a non-empty ` +
      `metrics body. That rules out a bad artifact directory, a typo'd kernel name, a kernel that never ran, and an ` +
      `instruction cutoff, so the empty result is one of two different things and this tool cannot tell them apart: ` +
      `either ${kernel} performs no shared-memory access in this run, or the analysis came back empty rather than ` +
      `finding none. Confirm it is the kernel you meant -- a kernel that reads or writes __shared__ memory reports 0 here ` +
      `only as a defect, and "measured: no conflicts" would be the wrong thing to quote from it. stats=${JSON.stringify(lds.stats)}`,
  );
}

console.log(`# ${kernel}  patterns=${lds.patterns.length}  stats=${JSON.stringify(lds.stats)}`);
for (const pattern of lds.patterns) {
  const maxBank = Math.max(...pattern.phases.flatMap((phase) => phase.bankAddrs ?? [0]));
  console.log(
    [
      pattern.name.padEnd(14),
      `pc=${pattern.pc}`,
      `degree=${pattern.degree}`,
      `stride=${pattern.stride}`,
      `phases=${pattern.phases.length}`,
      `maxBankAddrs=${maxBank}`,
      `lanesPerPhase=${pattern.phases.map((phase) => (phase.lanes === null ? 0 : phase.lanes.length)).join("/")}`,
    ].join("  "),
  );
}
console.log(`# stdout ${JSON.stringify(Buffer.concat(stdoutChunks.map((c) => Buffer.from(c))).toString("utf8"))}`);
