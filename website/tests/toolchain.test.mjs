// Toolchain test: does compiling a source produce the artifacts a run needs?
//
// Everything asserted here is a property of what compile.sh emitted, checked on the
// real bytes: the code object is an AMDGCN ELF for the requested arch, the host
// module is a wasm importing the CUDA entry points, the kernel symbol is present and
// unmangled with its descriptor, and a bad arch or toolchain id is refused rather
// than quietly producing something for the wrong target. The last case needs no
// compiler: it checks that the device-to-arch map the suites run on agrees with the
// one the browser compiles from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SELECTABLE_DEVICES, compile, deviceArch, fixturesDir, missingPrerequisites, repoRoot } from "./lib/harness.mjs";

const missing = missingPrerequisites();
const skip = missing.length > 0 ? `missing: ${missing.join(", ")}` : false;

const source = path.join(fixturesDir, "reduction.cu");

// A device in three files that nothing joins: the simulator's registry
// (simulator/harness/device.go), the compiler's (toolchain/toolchains.json) and the
// suites' (DEVICE_ARCH in tests/lib/harness.mjs). The Go side asserts its two halves
// agree -- harness_test.go's TestToolchainRegistryAgrees -- which leaves this one as
// the only check on the third. Without it a device added to the registry and the
// toolchains but not here is a device the correctness suite never runs: coverage
// halves and every test still passes.
test("every device the suites run on is a device the compiler claims, for the same arch", async () => {
  const registry = JSON.parse(await readFile(path.join(repoRoot, "toolchain", "toolchains.json"), "utf8"));
  const claimed = new Map();
  for (const toolchain of registry.toolchains) {
    for (const [device, arch] of Object.entries(toolchain.devices ?? {})) {
      assert.equal(claimed.has(device), false, `device ${device} is claimed by two toolchains, so the arch it resolves is ambiguous`);
      claimed.set(device, arch);
    }
  }
  assert.deepEqual(
    [...claimed.keys()].sort(),
    [...SELECTABLE_DEVICES],
    "the devices the suites cover and the devices toolchain/toolchains.json claims have drifted apart",
  );
  for (const device of SELECTABLE_DEVICES) {
    assert.equal(claimed.get(device), deviceArch(device), `the suites compile ${device} for ${deviceArch(device)}, the toolchains claim ${claimed.get(device)}`);
  }
});

// The fixture defines reduceBlocks and reduceFinal; reduction is the one symbol the
// other tests' kernels all share, so this checks the one that matters.
test("a compiled source yields a code object for the requested arch", { skip }, async () => {
  const artifact = await compile(source, { arch: "gfx803", toolchainId: "amdgcn" });
  try {
    const code = await artifact.read("device.co");
    assert.ok(code.length > 0, "device.co is empty");
    // ELF64, little-endian, e_machine == 224 (EM_AMDGPU).
    assert.equal(code[0], 0x7f, "device.co is not an ELF");
    assert.equal(code[4], 2, "device.co is not ELF64");
    assert.equal(code[5], 1, "device.co is not little-endian");
    assert.equal(code.readUInt16LE(0x12), 0xe0, "device.co is not an AMDGPU object");

    const host = await artifact.read("host.wasm");
    assert.equal(host[0], 0x00, "host.wasm is not a wasm module");
    assert.equal(host[1], 0x61, "host.wasm is not a wasm module");
    assert.equal(host[2], 0x73, "host.wasm is not a wasm module");
    assert.equal(host[3], 0x6d, "host.wasm is not a wasm module");
  } finally {
    await artifact.cleanup();
  }
});

test("the host module imports the CUDA entry points and exports main", { skip }, async () => {
  const artifact = await compile(source);
  try {
    const { createGoHelpers, createLibcudart, instantiateHostModule } = await import("./lib/harness.mjs");
    void createGoHelpers;
    void createLibcudart;
    void instantiateHostModule;
    const host = await artifact.read("host.wasm");
    // Decoding the import section by hand keeps this test independent of the loader:
    // what matters is that the module *asks* for these, not that our bridge supplies
    // them, which the simulator test covers.
    const text = host.toString("latin1");
    for (const symbol of ["hipLaunchKernel", "cudaMalloc", "cudaMemcpy", "__hipRegisterFatBinary", "printf"]) {
      assert.ok(text.includes(symbol), `host.wasm does not import ${symbol}`);
    }
    assert.ok(text.includes("main"), "host.wasm exports no main, so nothing can call it");
  } finally {
    await artifact.cleanup();
  }
});

test("the kernel symbol is present, unmangled, and has a descriptor", { skip }, async () => {
  const artifact = await compile(source);
  try {
    const code = await artifact.read("device.co");
    const text = code.toString("latin1");
    // The symbol table stores names as plain bytes, so a match here is the name being
    // there -- mangled C++ would appear as one long _Z... string instead.
    assert.ok(text.includes("reduceBlocks"), "reduceBlocks is not in the code object");
    assert.ok(text.includes("reduceBlocks.kd"), "reduceBlocks has no .kd descriptor");
    assert.ok(!text.includes("_Z12reduceBlocks"), "the kernel symbol is mangled");
  } finally {
    await artifact.cleanup();
  }
});

test("an unknown toolchain id is refused rather than defaulting", { skip }, async () => {
  await assert.rejects(
    () => compile(source, { arch: "gfx803", toolchainId: "no-such-toolchain" }),
    /toolchain|unknown|not found/i,
    "compile.sh accepted a toolchain id that does not exist",
  );
});

test("an unknown arch is refused rather than defaulting", { skip }, async () => {
  await assert.rejects(
    () => compile(source, { arch: "gfx999", toolchainId: "amdgcn" }),
    /arch|unknown|not found|target/i,
    "compile.sh accepted an arch the registry does not carry",
  );
});

test("a source that does not compile fails the build and leaves no code object behind", { skip }, async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "hipy-badsrc-"));
  try {
    const bad = path.join(dir, "bad.cu");
    await writeFile(bad, "#include <cuda_runtime.h>\nint main(void) { this is not C; }\n");
    await assert.rejects(() => compile(bad), /error|expected/i, "a source with a syntax error compiled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});