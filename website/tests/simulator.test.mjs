// Simulator test: does a compiled source run in the simulator and produce output?
//
// This is the seam between the two halves. The toolchain test checks what compile.sh
// emitted; this checks that the emulator can execute those instructions and that the
// host module's printf reaches us. Every case here compiles a fixture for real and
// runs it in the real wasm simulator, so an unimplemented opcode shows up as a panic
// rather than as a silently wrong number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyConfiguration, catalogForInstance, compile, compileAndRun, fixturesDir, missingPrerequisites, runArtifact } from "./lib/harness.mjs";

const missing = missingPrerequisites();
const skip = missing.length > 0 ? `missing: ${missing.join(", ")}` : false;

test("a compiled kernel runs to completion and prints its output", { skip }, async () => {
  const result = await compileAndRun(path.join(fixturesDir, "reduction.cu"));
  assert.equal(result.bridgeError, null, `bridge error: ${result.bridgeError}`);
  // drain 0 means the run finished on its own. 1 would mean the instruction budget
  // stopped it, which is a different failure from a wrong answer.
  assert.equal(result.drained, 0, "the run stopped on the instruction budget instead of finishing");
  assert.ok(result.stdout.length > 0, "the program printed nothing");
});

test("a run streams live gauges while it is still executing", { skip }, async () => {
  // The only test that watches a run rather than its result. Everything else here
  // reads the finished telemetry body, which is by definition after the fact --
  // so nothing else here can tell a working live stream from one that never fired.
  //
  // matmul-conflict is the fixture because it is one of the two expensive ones:
  // it retires ~690,000 instructions, and the stream is paced at one flush per 256
  // retired instructions, so a kernel too small to cross the stride produces no
  // samples at all. Asserting on a cheap fixture would therefore be asserting
  // either nothing or the wrong thing.
  const result = await compileAndRun(path.join(fixturesDir, "matmul-conflict.cu"));
  assert.equal(result.bridgeError, null);
  assert.equal(result.drained, 0);

  assert.ok(result.metrics > 0,
    "no live gauge sample arrived during a ~690,000-instruction run: the import is " +
    "wired but nothing called it, which no other test here can detect");

  // One sample per ~256 instructions, floored at one per 200ms of wall time, and
  // this run took seconds. A ceiling rather than an exact count, because the wall
  // clock decides it: the thing being asserted is that the stream is paced rather
  // than flooding, which is what makes it affordable at all.
  assert.ok(result.metrics < 500,
    `${result.metrics} samples is far more than the 200ms floor allows for this run: the stream is flooding`);
});

test("a kernel needing several launches runs all of them", { skip }, async () => {
  // prefixsum launches three kernels and only the third produces the answer, so a
  // harness that dropped or reordered a launch cannot pass this.
  const result = await compileAndRun(path.join(fixturesDir, "prefixsum.cu"));
  assert.equal(result.bridgeError, null);
  assert.equal(result.drained, 0);
  assert.equal(result.values.length, 128, "expected 128 scanned values");
});

test("a kernel using LDS completes, which it cannot if the LDS handlers are wrong", { skip }, async () => {
  const result = await compileAndRun(path.join(fixturesDir, "bitonicsort.cu"));
  assert.equal(result.bridgeError, null);
  assert.equal(result.drained, 0);
  assert.equal(result.values.length, 64);
});

test("an unknown kernel symbol is reported instead of run", { skip }, async () => {
  const artifact = await compile(path.join(fixturesDir, "reduction.cu"));
  try {
    // Loading a code object whose program has no such symbol must fail loudly. The
    // harness loads by symbol, so this is the check that it does not fall back to
    // running whatever happens to be at the entry point.
    const bad = await artifact.read("device.co");
    assert.ok(bad.length > 0);
    // A truncated object cannot be loaded: the ELF header is intact but there is no
    // program behind it.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "hipy-badco-"));
    try {
      await writeFile(path.join(dir, "device.co"), bad.subarray(0, 64));
      await writeFile(path.join(dir, "host.wasm"), await artifact.read("host.wasm"));
      await assert.rejects(() => runArtifact(dir), /ELF|load|header|unexpected end/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await artifact.cleanup();
  }
});
// Asserted against the POST-drain sample: the last live sample DURING a run carries
// none of the L2 write-back, so it reports 0 bytes written at every cache level.
test("the final live sample carries the cache levels and the flushed writes", async () => {
  const result = await compileAndRun(path.join(import.meta.dirname, "..", "src", "examples", "matmul-naive.cu"), { device: "gcn3generic" });
  const m = result.lastSample;
  assert.ok(m, "a finished run must leave a final live sample");

  // GCN3 has L1 and L2 and no MALL, and the simulator says so rather than the
  // website assuming it.
  assert.deepEqual(Object.keys(m.memLevels).sort(), ["L1", "L2"]);

  // 128x128 floats: exactly N*N*sizeof(float) at each level.
  const EXPECTED = 128 * 128 * 4;
  for (const level of ["L1", "L2"]) {
    assert.equal(m.memLevels[level].writeSinceLaunchBytes, EXPECTED,
      `${level} writes should be the kernel's whole output, got ${m.memLevels[level].writeSinceLaunchBytes}`);
  }
  assert.equal(m.dramWriteSinceLaunchBytes, EXPECTED + 434,
    "DRAM writes are the same output plus the kernarg/AQL packet");
  assert.ok(m.dramReadSinceLaunchBytes > 0, "DRAM reads must be non-zero on GCN3");
});

// The other half of that assertion, and the only end-to-end coverage of a warp
// store that STRADDLES a cache line.
//
// The test above runs src/examples/matmul-naive.cu, which is BLOCK_X 32: a warp is
// 32 lanes of one row, so its store is 128 contiguous bytes and lands on whole cache
// lines. Every shipped example is that shape. This fixture is BLOCK_X 8, so a warp
// covers four rows and each of its four store segments is half a line -- which is
// the case where the write byte count went wrong, because a WriteReq carries a whole
// line's buffer and only DirtyMask says how much of it was written.
//
// With the buffer counted instead of the mask, L1 and L2 reported twice the
// application's stores while DRAM reported the right figure, because L2 merges the
// halves before writing back. So the property worth asserting is not just "L1 is
// N*N*4" but "L1, L2 and DRAM agree" -- one level disagreeing with the others is
// exactly how this presented.
test("a warp store that straddles a cache line is counted once, at every level", async () => {
  const fixturePath = path.join(fixturesDir, "matmul-naive.cu");

  // Guard the shape this test depends on. If the fixture is ever widened to
  // BLOCK_X 32 to match the shipped examples, its warp stores stop straddling a
  // line and the case silently stops covering anything -- a test that keeps
  // passing while testing nothing is worse than no test, so fail loudly instead.
  const source = readFileSync(fixturePath, "utf8");
  const blockX = Number(/^#define BLOCK_X (\d+)$/m.exec(source)?.[1]);
  assert.ok(Number.isFinite(blockX), "could not read BLOCK_X out of the fixture");
  assert.ok(blockX < 32,
    `matmul-naive.cu is BLOCK_X ${blockX}, so a warp store no longer straddles a cache ` +
    "line and this test would pass without exercising the masked write path. Widen the " +
    "shipped examples instead, or restore the narrow block here.");

  const result = await compileAndRun(fixturePath, { device: "gcn3generic" });
  const m = result.lastSample;
  assert.ok(m, "a finished run must leave a final live sample");

  // 16x16 floats at N=16: exactly N*N*sizeof(float).
  const EXPECTED = 16 * 16 * 4;
  for (const level of ["L1", "L2"]) {
    assert.equal(m.memLevels[level].writeSinceLaunchBytes, EXPECTED,
      `${level} writes should be the kernel's whole output; a figure of ${EXPECTED * 2} ` +
      "means the cache line buffer was counted instead of the bytes the mask names");
  }

  // DRAM agrees, allowing only the kernarg/AQL packet the launch itself writes.
  // It is not asserted to an exact offset: those bytes are the driver's, and
  // hardcoding them here is what would make this test brittle for no gain.
  assert.ok(m.dramWriteSinceLaunchBytes >= EXPECTED,
    `DRAM writes ${m.dramWriteSinceLaunchBytes} are fewer than the ${EXPECTED} bytes the ` +
    "kernel stored, so the three levels do not agree about the same run");
  assert.ok(m.dramWriteSinceLaunchBytes - EXPECTED < 4096,
    `DRAM writes exceed the kernel's output by ${m.dramWriteSinceLaunchBytes - EXPECTED} ` +
    "bytes, which is more than the launch's own bookkeeping");
});

// The Device-memory meter has to reflect the END of the run, not the end of the
// program's last cudaDeviceSynchronize.
//
// The live stream is driven by retired instructions, so it stops sampling when the
// last kernel retires, and a cudaDeviceSynchronize is a drain, which emits the final
// live sample. Without a drain after main returns, a program that allocates or frees
// after its last synchronize shows a meter frozen there: the later cudaFree never
// appears to take effect, and a later cudaMalloc never appears at all.
//
// finalizeRun (src/lib/telemetryReads.ts) is the shared step that drains once more
// once main has returned, and the worker and the test harness both call it. This
// asserts the result the step exists to produce.
test("device memory reflects the whole run, including work after the last synchronize", async () => {
  const result = await compileAndRun(path.join(fixturesDir, "vram-lifecycle.cu"), { device: "gcn3generic" });
  assert.equal(result.bridgeError, null, `bridge error: ${result.bridgeError}`);

  const m = result.lastSample;
  assert.ok(m, "a finished run must leave a final live sample");

  const perBuffer = 32 * 32 * 4;
  // Three buffers during the run, freed before main returns, plus one allocated
  // after the last synchronize and never freed.
  const duringRun = 3 * perBuffer;
  const atEndOfRun = perBuffer;

  // The frees registered: the meter fell by two buffers' worth.
  assert.ok(m.vramUsedBytes < duringRun,
    `device memory never dropped after the cudaFree calls: ${m.vramUsedBytes} is still the ` +
    `${duringRun} bytes the run started with, so the meter was frozen at the last ` +
    "cudaDeviceSynchronize");

  // And the late allocation is in the total rather than missing from it: exactly one
  // buffer is left, which is only true if both the frees and the late malloc were seen.
  assert.equal(m.vramUsedBytes, atEndOfRun,
    `device memory ended at ${m.vramUsedBytes} bytes; ${atEndOfRun} is the one buffer still ` +
    `allocated after the three frees, so either a free or the late malloc went unseen`);

  assert.ok(result.allSamples.length >= 2,
    "the run produced a single sample, so there was nothing after the synchronize to observe");
  assert.equal(m.vramUsedBytes, result.allSamples[result.allSamples.length - 1].vramUsedBytes,
    "the last sample is not the one the panel would show");
});

// A too-small L2 cannot be built at all. akita derives the set count as
// TotalByteSize / (WayAssociativity x blockSize) -- 1024 bytes per set, per bank,
// across 16 banks -- so anything under 16 KiB leaves zero sets and the first
// directory lookup panics with an integer divide by zero. The export refuses it at
// configure time instead, which is where a reader can act on it.
test("a cache size the platform cannot build is refused, not silently wrong", { skip }, async () => {
  const source = path.join(import.meta.dirname, "..", "src", "examples", "matmul-naive.cu");
  await assert.rejects(
    compileAndRun(source, { device: "gcn3generic", overrides: { l2Bytes: 4096 } }),
    /configure failed/,
    "a 4 KiB L2 was accepted; it leaves the cache with zero sets",
  );
});

test("a valid cache override runs and is honoured", { skip }, async () => {
  const source = path.join(import.meta.dirname, "..", "src", "examples", "matmul-naive.cu");
  const result = await compileAndRun(source, {
    device: "gcn3generic",
    overrides: { l2Bytes: 8 * 1024 * 1024, memoryBytes: 64 * 1024 * 1024 },
  });
  // The answer has to stay right: an override that changed the cache geometry must
  // not change what the kernel computes.
  assert.match(result.stdout, /c\[0\] = 256\.000000/);
  // And the allocator limit has to be the figure that was asked for, or the VRAM
  // gauge shows a number nothing enforces.
  assert.equal(result.lastSample.vramCapacityBytes, 64 * 1024 * 1024);
});

// Saving a configuration rebuilds the simulator, so the figures the catalog then
// reports are the ones the NEXT run is built from. This is the whole reason save is
// its own export rather than a field on the next run: the sizes reach the builders,
// so the harness holding the old platform has to be discarded.
//
// Uses applyConfiguration rather than configure, because configure refuses once a
// harness exists -- going through it would test a path the browser does not take.
test("saving a configuration makes the catalog describe the saved platform", { skip }, async () => {
  const source = path.join(import.meta.dirname, "..", "src", "examples", "matmul-naive.cu");

  // Build once with the device defaults and read what the catalog says.
  const before = await compileAndRun(source, { device: "gcn3generic" });
  await applyConfiguration(before.instance, { l2Bytes: 8 * 1024 * 1024, memoryBytes: 64 * 1024 * 1024 });

  const body = await catalogForInstance(before.instance, "gcn3generic");
  const device = body.devices.find((d) => d.figuresRead);
  assert.ok(device, "the catalog described no device after a save");
  assert.equal(device.l2Bytes, 8 * 1024 * 1024,
    "the catalog still describes the device default, so a reader would think the save did nothing");
  assert.equal(device.vramBytes, 64 * 1024 * 1024);
});

// The full Customize cycle: run, save a configuration, run again.
//
// Worth its own test because a save DISCARDS the harness, so the second run has to
// go through configure's "must be called before loadCodeObject" guard with nothing
// built. If the discard left the module in a state configure refuses, the reader's
// next Run would fail with an error that says nothing about what they did.
test("a run after a saved configuration still runs", { skip }, async () => {
  const source = path.join(import.meta.dirname, "..", "src", "examples", "matmul-naive.cu");

  const first = await compileAndRun(source, { device: "gcn3generic" });
  assert.match(first.stdout, /c\[0\] = 256\.000000/);

  await applyConfiguration(first.instance, { l2Bytes: 8 * 1024 * 1024 });

  // A second run, with the saved sizes in force. The worker builds a fresh Go
  // instance per run, so this exercises configure against an empty harness.
  const second = await compileAndRun(source, { device: "gcn3generic" });
  assert.equal(second.bridgeError, null, `bridge error: ${second.bridgeError}`);
  assert.match(second.stdout, /c\[0\] = 256\.000000/,
    "the second run after a save computed the wrong answer");
  // And the saved sizes are what it was built from, not the device defaults.
  assert.ok(second.lastSample.vramCapacityBytes > 0);
});
