// Correctness: every kernel computes what a CPU implementation computes, at every
// element, on every device the registry lets a learner pick.
//
// The kernels under test are mirrors of website/src/examples, shrunk by changing
// only their size constants -- REDUCE_N from 4096 to 512, the matmuls from 128x128
// to 16x16 -- with the algorithm text copied verbatim. So this exercises the same
// kernel shapes the playground ships, and runs in seconds rather than minutes.
//
// EVERY output element is compared. Each mirror prints its whole result, one value
// per line, and the reference is computed independently in JavaScript. Sampling a few
// values would let a reduction with a dropped partial pass pass, because the sampled
// ones are still right.
//
// Every fixture runs once per device, against that device's own CPU reference -- not
// against the other device's output, which would only show that two devices agree.
// The device is named in the test title and in every assertion message, so a failure
// says which GPU was wrong. Running per device is what keeps CDNA3 covered; a device
// no CI job exercises is one whose faults are found by hand, mislabelled as a missing
// opcode.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { SELECTABLE_DEVICES, compileAndRun, deviceArch, fixturesDir, missingPrerequisites } from "./lib/harness.mjs";
import { codeObjectText, vop1Opcode56Copies } from "./lib/isa.mjs";
import {
  TOLERANCE,
  bitonicExpected,
  cdna3MovB64Expected,
  opsArithExpected,
  opsControlExpected,
  opsMemoryExpected,
  compactionExpected,
  histogramExpected,
  matmulExpected,
  prefixSumExpected,
  radixExpected,
  reductionExpected,
  topKExpected,
} from "./lib/cpu-reference.mjs";

const missing = missingPrerequisites();
const skip = missing.length > 0 ? `missing: ${missing.join(", ")}` : false;

const cache = new Map();

/** Compile and run once per fixture per device, and return the whole result. */
function run(id, device) {
  const key = `${device}/${id}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      compileAndRun(path.join(fixturesDir, `${id}.cu`), { arch: deviceArch(device), device }).then((result) => {
        if (result.bridgeError) throw new Error(`${id} on ${device}: bridge error: ${result.bridgeError}`);
        if (result.drained !== 0) throw new Error(`${id} on ${device}: stopped on the instruction budget without finishing`);
        return result;
      }),
    );
  }
  return cache.get(key);
}

/** The values a fixture printed, compiled and run once per fixture per device. */
async function values(id, device) {
  return (await run(id, device)).values;
}

// Compares all of them, and names the first few that disagree. A reduction wrong
// everywhere and one wrong only at index 300 need different fixes, so "N values
// disagree" alone is not enough to act on.
async function assertMatchesCpu(id, expected, device) {
  const actual = await values(id, device);
  assert.equal(actual.length, expected.length, `${id} on ${device} printed ${actual.length} values, the CPU reference has ${expected.length}`);
  const wrong = [];
  for (let i = 0; i < expected.length; i++) {
    if (!Number.isFinite(actual[i]) || Math.abs(actual[i] - expected[i]) > TOLERANCE) {
      wrong.push(`${id}[${i}] on ${device} is ${actual[i]}, the CPU says ${expected[i]}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 5), [], wrong.length ? `${wrong.length} of ${expected.length} values disagree on ${device}` : "");
}

for (const device of SELECTABLE_DEVICES) {
  test(`reduction sums every element and matches a CPU total on ${device}`, { skip }, () =>
    assertMatchesCpu("reduction", reductionExpected(), device));

  test(`prefixsum matches the CPU exclusive scan at all 128 elements on ${device}`, { skip }, () =>
    assertMatchesCpu("prefixsum", prefixSumExpected(), device));

  test(`stream compaction emits the CPU filter's count and survivors on ${device}`, { skip }, () =>
    assertMatchesCpu("stream_compaction", compactionExpected(), device));

  test(`top-k by rank returns the CPU's largest 4 in descending order on ${device}`, { skip }, () =>
    assertMatchesCpu("topk-rank", topKExpected(), device));

  // Same reference as topk-rank, and deliberately not a comparison against that
  // kernel's output: two kernels agreeing only shows that they agree.
  test(`top-k by bisection returns the CPU's largest 4 in descending order on ${device}`, { skip }, () =>
    assertMatchesCpu("topk-bisect", topKExpected(), device));

  test(`histogram counts every value into the bin the CPU puts it in on ${device}`, { skip }, () =>
    assertMatchesCpu("histogram", histogramExpected(), device));

  test(`radix sort leaves all 64 keys where a CPU sort puts them on ${device}`, { skip }, () =>
    assertMatchesCpu("radixsort", radixExpected(), device));

  test(`bitonic sort leaves all 64 keys where a CPU sort puts them on ${device}`, { skip }, () =>
    assertMatchesCpu("bitonicsort", bitonicExpected(), device));

  for (const id of ["matmul-naive", "matmul-tiled", "matmul-conflict", "matmul-padded"]) {
    test(`${id} matches a CPU matrix multiply at all 256 elements on ${device}`, { skip }, () =>
      assertMatchesCpu(id, matmulExpected(), device));
  }

  // Operation coverage. The twelve mirrors above exercise the algorithms; these
  // isolate the operations and access shapes underneath them, so a regression is
  // attributable to arithmetic, to memory, or to control flow rather than showing
  // up as one example returning a wrong total.
  //
  // Every value is compared here too, which is the point of ops-arith: it folds
  // twenty-one scalar operations into one integer per lane, so an op that changes
  // shows up in exactly the lanes it applies to.

  // ops-arith found that float division is unimplemented -- clang emits VOP3b 480 for
  // it on gfx803 -- so the fixture omits it and says so. Everything else passes.
  test(`scalar arithmetic matches the CPU expression-by-expression on ${device}`, { skip }, () =>
    assertMatchesCpu("ops-arith", opsArithExpected(), device));

  // ops-memory separated the two ISAs: its strided-read-into-contiguous-write case
  // was correct on gfx803 and broken on gfx942. That gap is closed -- the fault it
  // found was cdna3's s_movk_i32, not an LDS decode -- so both ISAs agree, and the
  // suite says so by running here rather than asserting it in a comment.
  test(`global and shared access patterns match the CPU on ${device}`, { skip }, () =>
    assertMatchesCpu("ops-memory", opsMemoryExpected(), device));

  // The emulator splits a wavefront at every branch, so this is about which lanes
  // reach a store rather than about arithmetic.
  test(`divergent control flow matches the CPU on every lane on ${device}`, { skip }, () =>
    assertMatchesCpu("ops-control", opsControlExpected(), device));

  // v_mov_b64, which CDNA3 emits and MGPUSim's decode table lacked: a wide move
  // decoded as a 32-bit one, so the low word of every pair arrived and the high word
  // did not. Only gfx942 executes the instruction -- LLVM gates it on gfx940+ -- so
  // on the GCN3 device this is a plain scan, and running it there says so rather than
  // asserting it in a comment.
  //
  // The fixture's whole value rests on clang emitting v_mov_b64 for the pair copy, so
  // that is checked on the code object the run loaded rather than left in the
  // fixture's header. A clang that coalesced the wide copy into two 32-bit moves
  // would leave this test green while testing nothing -- and this is the only test
  // that would notice, since topk-bisect failing that way needs nothing else to
  // break first. Asserted per device so the gate is checked too: gfx803 must carry
  // no opcode-56 word at all, or the device is not the one DEVICE_ARCH says it is.
  test(`a 64-bit register move copies every word on ${device}`, { skip }, async () => {
    const { codeObject } = await run("cdna3-mov-b64", device);
    const copies = vop1Opcode56Copies(codeObjectText(codeObject));
    if (deviceArch(device) === "gfx942") {
      assert.ok(copies > 0, `the gfx942 code object for cdna3-mov-b64 carries no v_mov_b64, so this fixture is not testing the instruction it exists for (${copies} found)`);
    } else {
      assert.equal(copies, 0, `the ${device} code object carries a v_mov_b64, which LLVM gates on gfx940+: either the gate moved or this device is not ${deviceArch(device)}`);
    }
    await assertMatchesCpu("cdna3-mov-b64", cdna3MovB64Expected(), device);
  });
}
