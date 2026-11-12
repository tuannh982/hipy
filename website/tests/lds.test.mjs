// LDS test: does the bank-conflict analysis report a conflict when there is one?
//
// The analyzer is the only part of the simulator that models anything about the LDS
// beyond its bytes. MGPUSim itself holds shared memory as a flat []byte, so the bank
// structure comes entirely from the fork patch, and nothing else in the test suite
// would notice if it were wrong.
//
// Two fixtures differ in one constant. lds-conflict strides 32 floats, which is
// 128 bytes, exactly one bank row, so every lane of a phase wants the same bank.
// lds-padded strides 34, which is not a multiple of the row, so the lanes spread.
// The arithmetic is identical, so any difference in the reported degree is the bank
// model and nothing else.
//
// The padding is 2 floats rather than 1 because clang pairs the depth-8 read loop
// into ds_read2_b32: each lane then covers two adjacent words, and one float of
// padding leaves consecutive lanes sharing a bank. That still reports degree 2, which
// is the correct answer and the reason matmul-padded.cu pads by K_TILE + 16.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compileAndRun, fixturesDir, missingPrerequisites, repoRoot } from "./lib/harness.mjs";

const missing = missingPrerequisites();
const skip = missing.length > 0 ? `missing: ${missing.join(", ")}` : false;

const cache = new Map();

/** Run an LDS fixture and return its analysis plus the program's own values. */
function analyze(id) {
  if (!cache.has(id)) {
    cache.set(id, compileAndRun(path.join(fixturesDir, `${id}.cu`), { wantLds: true }));
  }
  return cache.get(id);
}

function patternsOf(result) {
  assert.ok(result.lds, "the harness exported no LDS analysis");
  const patterns = result.lds.patterns ?? [];
  assert.ok(patterns.length > 0, "the analysis reported no LDS access at all");
  return patterns;
}

// The worst degree the kernel produced at all. Answers "is there a conflict here".
function worst(result) {
  return patternsOf(result).reduce((a, b) => (b.degree > a.degree ? b : a));
}

// The tiled read specifically. Both fixtures also initialise the tile with a stride-4
// access that is conflict-free by construction, so picking the maximum degree alone
// can land on the wrong instruction once padding has removed every conflict: with all
// patterns at degree 1 the reduce returns whichever came first, and that was the
// initialiser. The tile read is the only access striding a whole bank row or more.
function tileRead(result) {
  const reads = patternsOf(result).filter((pattern) => pattern.name.startsWith("ds_read") && pattern.stride >= 128);
  assert.ok(reads.length > 0, "the analysis reported no strided tile read");
  return reads.reduce((a, b) => (b.degree > a.degree ? b : a));
}

test("a strided LDS read is analysed and its degree reported", { skip }, async () => {
  const result = await analyze("lds-conflict");
  assert.equal(result.bridgeError, null, `bridge error: ${result.bridgeError}`);
  const worstPattern = worst(result);
  assert.ok(worstPattern.degree >= 2, `expected a conflict, got degree ${worstPattern.degree}`);
  assert.match(worstPattern.name, /^ds_read/, `unexpected LDS opcode ${worstPattern.name}`);
});

test("padding the stride away removes the conflict the analyzer reported", { skip }, async () => {
  const conflicted = tileRead(await analyze("lds-conflict"));
  const padded = tileRead(await analyze("lds-padded"));
  assert.ok(
    padded.degree < conflicted.degree,
    `padding did not reduce the degree: ${conflicted.degree} conflicted against ${padded.degree} padded`,
  );
});

test("the padded stride is reported conflict-free", { skip }, async () => {
  const padded = tileRead(await analyze("lds-padded"));
  assert.equal(padded.degree, 1, `expected degree 1 with a padded stride, got ${padded.degree}`);
});

test("the analyzer's stride matches what each fixture strides by", { skip }, async () => {
  // 32 floats is 128 bytes; 33 floats is 132. If the analyzer's stride arithmetic were
  // wrong these would not match, and a wrong stride would in turn make the degrees
  // meaningless -- so this is the check underneath the three above.
  const conflicted = tileRead(await analyze("lds-conflict"));
  const padded = tileRead(await analyze("lds-padded"));
  assert.equal(conflicted.stride, 128, `expected a 128-byte stride, got ${conflicted.stride}`);
  assert.equal(padded.stride, 136, `expected a 136-byte stride, got ${padded.stride}`);
});

test("an LDS kernel still computes the right answer", { skip }, async () => {
  // The analysis must not change what runs. Each lane sums DEPTH floats starting at
  // lane * TILE_STRIDE, so the total is known without a reference implementation.
  for (const [id, stride] of [["lds-conflict", 32], ["lds-padded", 34]]) {
    const result = await analyze(id);
    assert.equal(result.bridgeError, null, `${id}: bridge error: ${result.bridgeError}`);
    assert.equal(result.drained, 0, `${id} stopped on the instruction budget`);
    const depth = 8;
    const expected = [];
    for (let lane = 0; lane < 64; lane++) {
      let sum = 0;
      for (let k = 0; k < depth; k++) sum += lane * stride + k;
      expected.push(sum);
    }
    assert.deepEqual(result.values, expected, `${id} computed the wrong tile sums`);
  }
});

// The bank-conflict lesson runs the lesson's own files rather than a fixture, so the
// numbers its prose quotes -- a 32-way conflict, then none -- are pinned by the suite
// rather than asserted by the lesson. A lesson whose starter no longer conflicts would
// teach a task that cannot be observed, and a solution that still conflicts would
// teach a lie.
const lessonDir = path.join(
  repoRoot,
  "website",
  "src",
  "lessons",
  "gpgpu-101",
  "1-2-thinking-in-parallel",
  "6-bank-conflict",
);

/** The degree of the lesson's shared-memory read: the access that reads a column. */
function lessonReadDegree(result) {
  const reads = patternsOf(result).filter((pattern) => pattern.isRead);
  assert.ok(reads.length > 0, "the lesson kernel reported no LDS read");
  return reads.reduce((a, b) => (b.degree > a.degree ? b : a)).degree;
}

test("the bank-conflict lesson's starter conflicts and its padded solution does not", { skip }, async () => {
  const conflicted = await compileAndRun(path.join(lessonDir, "starter.cu"), { wantLds: true });
  const padded = await compileAndRun(path.join(lessonDir, "solution.cu"), { wantLds: true });
  assert.equal(conflicted.bridgeError, null, `bridge error: ${conflicted.bridgeError}`);
  assert.equal(padded.bridgeError, null, `bridge error: ${padded.bridgeError}`);
  assert.equal(lessonReadDegree(conflicted), 32, "the lesson's starter should hit a 32-way conflict");
  assert.equal(lessonReadDegree(padded), 1, "the padded tile should be conflict-free");
  // The lesson claims the padding changes nothing but the speed. The printed result
  // is the observable half of that claim.
  assert.equal(conflicted.stdout, padded.stdout, "padding changed the transpose's result");
});
