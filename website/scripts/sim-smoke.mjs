import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

const args = process.argv.slice(2);
const repoRoot = resolve(import.meta.dirname, "..");
const artifactDir = process.env.ARTIFACT_DIR ?? args[0] ?? resolve(repoRoot, "..", "toolchain", "build", "smoke");
const simWasmPath = process.env.SIM_WASM ?? "/tmp/sim-runner.wasm";
const wasmExecPath = process.env.SIM_WASM_EXEC ?? "/tmp/wasm_exec.js";
const hostWasmPath = process.env.HOST_WASM ?? args[1] ?? resolve(artifactDir, "host.wasm");
const deviceCodeObjectPath = process.env.DEVICE_CODE_OBJECT ?? args[2] ?? resolve(artifactDir, "device.co");

await import(pathToFileURL(wasmExecPath));
const { anyClaimedDevice } = await tsImport("../src/lib/toolchains.ts", import.meta.url);
const bridge = await tsImport("../src/lib/libcudart.ts", import.meta.url);
const { createGoHelpers, createLibcudart, elfImageExtent, instantiateHostModule } = bridge;
const decoder = new TextDecoder();
const setU16 = (bytes, offset, value) => new DataView(bytes.buffer).setUint16(offset, value, true);
const setU32 = (bytes, offset, value) => new DataView(bytes.buffer).setUint32(offset, value, true);
const setU64 = (bytes, offset, value) => new DataView(bytes.buffer).setBigUint64(offset, BigInt(value), true);
const makeElf = ({ elfClass, phoff = 0, shoff = 0, phentsize = 0, phnum = 0, shentsize = 0, shnum = 0, pOffset = 0, pFileSize = 0, length }) => {
  const bytes = new Uint8Array(length);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, 1, 1]);
  if (elfClass === 1) {
    setU32(bytes, 28, phoff);
    setU32(bytes, 32, shoff);
    setU16(bytes, 42, phentsize);
    setU16(bytes, 44, phnum);
    setU16(bytes, 46, shentsize);
    setU16(bytes, 48, shnum);
  } else {
    setU64(bytes, 32, phoff);
    setU64(bytes, 40, shoff);
    setU16(bytes, 54, phentsize);
    setU16(bytes, 56, phnum);
    setU16(bytes, 58, shentsize);
    setU16(bytes, 60, shnum);
  }
  if (phnum > 0) {
    if (elfClass === 1) {
      setU32(bytes, phoff + 4, pOffset);
      setU32(bytes, phoff + 16, pFileSize);
    } else {
      setU64(bytes, phoff + 8, pOffset);
      setU64(bytes, phoff + 32, pFileSize);
    }
  }
  return bytes;
};
const assertElfExtent = (name, bytes, expected) => {
  const actual = elfImageExtent(bytes);
  if (actual !== expected) throw new Error(`${name}: expected extent ${expected}, got ${actual}`);
  console.log(`PASS: ${name}`);
};
assertElfExtent("ELF32 sectionless program extent", makeElf({ elfClass: 1, phoff: 52, phentsize: 32, phnum: 1, pOffset: 70, pFileSize: 4, length: 100 }), 84);
assertElfExtent("ELF64 section header extent", makeElf({ elfClass: 2, shoff: 128, shentsize: 64, shnum: 1, length: 256 }), 192);
assertElfExtent("ELF64 sectionless program extent", makeElf({ elfClass: 2, phoff: 64, phentsize: 56, phnum: 1, pOffset: 150, pFileSize: 40, length: 200 }), 190);
assertElfExtent("ELF64 header-only sectionless extent", makeElf({ elfClass: 2, length: 64 }), 64);
assertElfExtent("non-ELF rejection", new Uint8Array([0xde, 0xad, 0xbe, 0xef]), null);
assertElfExtent("truncated ELF rejection", makeElf({ elfClass: 2, shoff: 128, shentsize: 64, shnum: 1, length: 63 }), null);
const [simBytes, hostBytes, deviceCodeObject, manifestRaw] = await Promise.all([
  readFile(simWasmPath),
  readFile(hostWasmPath),
  readFile(deviceCodeObjectPath),
  readFile(new URL("../../simulator/testdata/fixtures.json", import.meta.url), "utf8"),
]);
const manifest = JSON.parse(manifestRaw);
const examplesByKernel = new Map(manifest.examples.map((example) => [example.kernel, example]));
const expectedForKernel = (name) => examplesByKernel.get(name)?.expect;

const go = new globalThis.Go();
// sim-runner.wasm declares env.pushMetrics as an IMPORT, and wasm resolves imports
// at INSTANTIATION, so a missing one is a hard failure there rather than a nil call
// later. Every consumer of this binary has to supply one: this script, the worker,
// and the test harnesses.
//
// The production callback, because the pointer it receives arrives sign-extended and
// a no-op cannot fail on an address above 2 GiB. Bodies that cannot be read are
// recorded and asserted empty at the end of the run instead.
const { createMetricsStream } = await tsImport("../src/lib/metricsStream.ts", import.meta.url);
const metricFailures = [];
let sampleCount = 0;
let goInstance = null;
({ instance: goInstance } = await WebAssembly.instantiate(simBytes, {
  ...go.importObject,
  env: {
    ...(go.importObject?.env ?? {}),
    pushMetrics: createMetricsStream({
      memory: () => goInstance?.exports.mem ?? null,
      onMetrics: () => { sampleCount++; },
      onUnreadable: (message) => metricFailures.push(message),
    }),
  },
}));
const goRun = go.run(goInstance);
void goRun.catch(() => {});
const exports = goInstance.exports;
const { goCall: call, goWrite, goRead } = createGoHelpers(goInstance);

// This script runs a code object the caller already compiled, so it configures a
// device rather than choosing a target: no compiler flags are involved and the
// name only has to be one the simulator can build.
const claimed = anyClaimedDevice();
if (claimed === null) throw new Error("toolchain/toolchains.json claims no device");
const deviceName = new TextEncoder().encode(claimed);
if (call("configure", 2_000_000, goWrite(deviceName), deviceName.length) !== 0) {
  throw new Error("configure failed");
}
const codeObjectPtr = goWrite(deviceCodeObject);
if (call("loadCodeObject", codeObjectPtr, deviceCodeObject.length) !== 0) throw new Error("loadCodeObject failed");

const stdoutChunks = [];
const onStdout = (bytes) => {
  stdoutChunks.push(new Uint8Array(bytes));
  const ptr = goWrite(bytes);
  if (call("writeStdout", ptr, bytes.length) !== 0) throw new Error("writeStdout failed");
};
const hostReference = { exports: { memory: null } };
const rawBridge = createLibcudart({ go, goInstance, hostInstance: hostReference, onStdout });
let mallocCount = 0;
let h2dCount = 0;
const libcudart = {
  ...rawBridge,
  cudaMalloc: (...args) => {
    const status = rawBridge.cudaMalloc(...args);
    if (status === 0) mallocCount++;
    return status;
  },
  cudaMemcpy: (...args) => {
    const status = rawBridge.cudaMemcpy(...args);
    if (status === 0 && args[3] === 1) h2dCount++;
    return status;
  },
};
const hostModule = await WebAssembly.compile(hostBytes);
const hostInstance = await instantiateHostModule(hostBytes, libcudart, hostReference, onStdout);
if (!(hostInstance instanceof WebAssembly.Instance)) throw new Error("host module did not produce a WebAssembly.Instance");
const status = hostInstance.exports.main(0, 0);
if (status !== 0) throw new Error(`host main returned ${status}`);
console.log("PASS: host module instance and main");
const bridgeError = libcudart.getInternalError();
if (bridgeError) throw new Error(`bridge error: ${bridgeError}`);
const registrations = libcudart.getKernelRegistrations();
if (registrations.length === 0) throw new Error("host module registered no kernels");
for (const registration of registrations) {
  if (!expectedForKernel(registration.name)) {
    throw new Error(`no manifest expectation for registered kernel ${registration.name}`);
  }
}
const launched = libcudart.getLaunchedKernels();
// The kernel the telemetry names is the LAST one launched, not the first one
// registered: the harness records a single lastKernelName and stamps the metrics with
// it, so a multi-launch source reports its final kernel.
const kernelName = launched.length === 0 ? registrations[0].name : launched[launched.length - 1].name;
const expected = expectedForKernel(kernelName);
const launchedNames = launched.map((kernel) => kernel.name);
const registeredNames = registrations.map((registration) => registration.name);
for (const name of registeredNames) {
  if (!launchedNames.includes(name)) {
    throw new Error(`registered kernel ${name} was never launched: ${JSON.stringify(launchedNames)}`);
  }
}
// Ordered list equality, not set membership: a re-launched kernel, an extra launch, or
// a different launch order all have to fail.
if (launchedNames.length !== registeredNames.length || launchedNames.some((name, index) => name !== registeredNames[index])) {
  throw new Error(`launched ${JSON.stringify(launchedNames)} does not match registered ${JSON.stringify(registeredNames)}`);
}

const metricsLength = call("metrics");
const metrics = JSON.parse(decoder.decode(goRead(call("resultPtr"), metricsLength)));
const stdoutLength = call("stdoutLen");
const stdout = decoder.decode(goRead(call("stdoutPtr"), stdoutLength));
const capturedStdout = decoder.decode(Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk))));
const hasPrintf = WebAssembly.Module.imports(hostModule).some((item) => item.module === "env" && item.name === "printf");
const expectedStdout = hasPrintf ? expected.stdout : "";

const otlpMetricNames = (body) =>
  (body.resourceMetrics ?? []).flatMap((resource) => (resource.scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.name)));
const otlpAttributes = (values) => new Map((values ?? []).map((item) => [item.key, item.value?.stringValue]));
const otlpKernelDurationName = "hipy.simulator.kernel.duration";

if (mallocCount !== expected.mallocCount || h2dCount !== expected.h2dCount) {
  throw new Error(`expected ${expected.mallocCount} successful allocations and ${expected.h2dCount} H2D copies, got ${mallocCount} and ${h2dCount}`);
}
if (metricsLength <= 0 || !Array.isArray(metrics.resourceMetrics) || metrics.resourceMetrics.length === 0) {
  throw new Error(`unexpected metrics body: ${JSON.stringify(metrics)}`);
}
const metricNames = otlpMetricNames(metrics);
if (!metricNames.includes(otlpKernelDurationName)) {
  throw new Error(`OTLP metrics body is missing ${otlpKernelDurationName}: ${JSON.stringify(metricNames)}`);
}
const kernelDurationPoint = metrics.resourceMetrics
  .flatMap((resource) => resource.scopeMetrics ?? [])
  .flatMap((scope) => scope.metrics ?? [])
  .find((metric) => metric.name === otlpKernelDurationName)
  .gauge.dataPoints[0];
const otlpKernelName = otlpAttributes(kernelDurationPoint.attributes).get("hipy.kernel.name");
if (otlpKernelName !== kernelName) {
  throw new Error(`OTLP kernel metric names ${JSON.stringify(otlpKernelName)}, want ${JSON.stringify(kernelName)}`);
}
if (!(Number(kernelDurationPoint.asInt ?? kernelDurationPoint.asDouble) > 0)) {
  throw new Error(`OTLP kernel duration metric is not positive: ${JSON.stringify(kernelDurationPoint)}`);
}
if (stdout !== expectedStdout || capturedStdout !== expectedStdout) {
  throw new Error(`expected stdout ${JSON.stringify(expectedStdout)}, got ${JSON.stringify({ stdout, capturedStdout })}`);
}
const negativeBridge = createLibcudart({ go, goInstance, hostInstance, onStdout });
const negativeMallocStatus = negativeBridge.cudaMalloc(0, 0);
if (negativeMallocStatus === 0) throw new Error("cudaMalloc(0) unexpectedly succeeded");
if (!negativeBridge.getInternalError()?.includes("invalid allocation size")) {
  throw new Error(`unexpected cudaMalloc(0) error: ${negativeBridge.getInternalError()}`);
}
if (negativeBridge.cudaGetLastError() === 0) throw new Error("cudaGetLastError did not report cudaMalloc(0) failure");
if (negativeBridge.cudaDeviceSynchronize() === 0) throw new Error("cudaDeviceSynchronize did not report cudaMalloc(0) failure");
console.log("PASS: malloc error status and bridge error propagation");
console.log("PASS: malloc ok");
console.log("PASS: H2D ok");
console.log("PASS: kernel ran");
console.log("PASS: stdout correct");
console.log("PASS: metrics non-empty");
console.log(`PASS: OTLP kernel metric ${otlpKernelDurationName} for ${otlpKernelName}`);

const kernelRegistration = registrations.find((registration) => registration.name === kernelName);
if (!kernelRegistration) throw new Error(`${kernelName} registration is missing`);
const hostMemory = new Uint8Array(hostInstance.exports.memory.buffer);
const writeU32 = (ptr, value) => new DataView(hostInstance.exports.memory.buffer).setUint32(ptr, value, true);
const badBridge = createLibcudart({ go, goInstance, hostInstance, onStdout });
const badWrapperPtr = hostMemory.length - 128;
const badDataPtr = badWrapperPtr + 32;
writeU32(badWrapperPtr, 0x48495046);
writeU32(badWrapperPtr + 4, 1);
writeU32(badWrapperPtr + 8, badDataPtr);
writeU32(badWrapperPtr + 12, 0);
new Uint8Array(hostInstance.exports.memory.buffer, badDataPtr, 4).set([0xde, 0xad, 0xbe, 0xef]);
if (badBridge.__hipRegisterFatBinary(badWrapperPtr) === 0) throw new Error("unknown non-ELF fat-binary image unexpectedly succeeded");
if (badBridge.getInternalError() !== `unable to determine fat-binary image extent for non-ELF data at ${badDataPtr}`) {
  throw new Error(`unexpected non-ELF fat-binary error: ${badBridge.getInternalError()}`);
}
const corruptBridge = createLibcudart({ go, goInstance, hostInstance, onStdout });
const corruptWrapperPtr = badWrapperPtr + 16;
const corruptDataPtr = corruptWrapperPtr + 32;
writeU32(corruptWrapperPtr, 0x48495046);
writeU32(corruptWrapperPtr + 4, 1);
writeU32(corruptWrapperPtr + 8, corruptDataPtr);
writeU32(corruptWrapperPtr + 12, 0);
new Uint8Array(hostInstance.exports.memory.buffer, corruptDataPtr, 63).set(makeElf({ elfClass: 2, shoff: 128, shentsize: 64, shnum: 1, length: 63 }));
if (corruptBridge.__hipRegisterFatBinary(corruptWrapperPtr) === 0) throw new Error("truncated ELF fat-binary image unexpectedly succeeded");
if (corruptBridge.getInternalError() !== "fat-binary ELF image extent is invalid") {
  throw new Error(`unexpected truncated ELF fat-binary error: ${corruptBridge.getInternalError()}`);
}
console.log("PASS: truncated ELF fat-binary rejection");

const actualStdout = stdout || capturedStdout;
if (metricFailures.length > 0) {
  throw new Error(`the metrics callback could not read Go memory: ${metricFailures.join("; ")}`);
}
console.log("PASS: metrics stream readable");
console.log(`smoke ok: metrics_resource_metrics=${metrics.resourceMetrics.length} otlp_kernel_metric=${otlpKernelDurationName} samples=${sampleCount}`);
console.log(`stdout: ${JSON.stringify(actualStdout)}`);
console.log(`OTLP metric names: ${metricNames.join(", ")}`);
console.log(`host imports: ${WebAssembly.Module.imports(hostModule).map((item) => `${item.module}.${item.name}`).join(", ")}`);
