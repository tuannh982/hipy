// The CUDA lint rules.
//
// These are the diagnostics an editor shows on every keystroke, which sets the bar
// higher than it looks. A wrong marker in a squiggle column teaches a learner to
// ignore the column, and that costs more than the marker was ever worth -- so
// every test below is as much about what the rules must NOT report as about what
// they must. The false-positive cases are the point of the file, and the reason
// one of them exists is written down at its test.
//
// The completion, hover and signature-help tables are not tested here. They are
// data, they are exercised through the editor, and a test asserting that
// CUDA_KEYWORDS contains "__syncthreads" would only assert that somebody typed it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const { lintCuda, cudaIdentifiers, BLOCK_KINDS } = await tsImport(
  path.join(repoRoot, "website", "src", "lib", "cudaLanguage.ts"),
  import.meta.url,
);

/** The rule ids reported, in order. */
function ids(source) {
  return lintCuda(source).map((rule) => rule.id);
}

/** The single rule reported, failing if there is not exactly one. */
function only(source) {
  const rules = lintCuda(source);
  assert.equal(rules.length, 1, `expected one rule, got ${JSON.stringify(rules.map((r) => r.id))}`);
  return rules[0];
}

/** A kernel with a __shared__ tile, so a barrier-only rule does not also fire. */
function kernel(body, signature = "float* out, int n") {
  return `__global__ void k(${signature}) {\n    __shared__ float tile[64];\n${body}\n}\n`;
}

test("a correct program reports nothing", () => {
  const source = `
__global__ void add(const float* a, const float* b, float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        c[i] = a[i] + b[i];
    }
}
int main() {
    float* d = nullptr;
    cudaMalloc(&d, 64);
    cudaDeviceSynchronize();
    return 0;
}
`;
  assert.deepEqual(ids(source), [], "a correct program produced lint markers");
});

test("a barrier at the top level of a kernel body is not flagged", () => {
  assert.deepEqual(ids(kernel("    tile[0] = in[0];\n    __syncthreads();\n    out[0] = tile[0];", "const float* in, float* out")), []);
});

test("a barrier inside an if is a divergent barrier", () => {
  // The bug worth catching: the barrier is a block-wide rendezvous, and threads
  // that took the other branch never arrive.
  const rule = only(kernel("    if (threadIdx.x < n) {\n        __syncthreads();\n    }"));
  assert.equal(rule.id, "divergent-barrier");
  assert.equal(rule.severity, "warning");
  assert.match(rule.message, /deadlocks/);
  // The wording has to be conditional: the rule cannot see whether the condition
  // is uniform across the block, so it must not assert that it is not.
  assert.match(rule.message, /if the condition is not the same/);
});

test("a barrier inside an else is a divergent barrier", () => {
  assert.equal(only(kernel("    if (threadIdx.x) {\n        out[0] = 1.0f;\n    } else {\n        __syncthreads();\n    }")).id, "divergent-barrier");
});

test("a barrier inside a LOOP is not flagged, because that IS the reduction", () => {
  // The false positive that would make this rule unusable. A
  // barrier inside a loop is the inner step of every correct block reduction --
  // the loop bound is uniform, so every thread reaches the barrier every
  // iteration. Warning on this puts a squiggle on the textbook answer, and a
  // learner who sees that stops reading the column.
  const source = `
__global__ void reduce(const float* in, float* out) {
    __shared__ float partials[256];
    partials[threadIdx.x] = in[threadIdx.x];
    __syncthreads();
    for (unsigned stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (threadIdx.x < stride) partials[threadIdx.x] += partials[threadIdx.x + stride];
        __syncthreads();
    }
    if (threadIdx.x == 0) out[0] = partials[0];
}
`;
  assert.deepEqual(ids(source), [], "the canonical block reduction was reported");
});

test("a barrier in a while loop is not flagged either", () => {
  assert.deepEqual(ids(kernel("    while (true) {\n        __syncthreads();\n        break;\n    }")), []);
});

test("an identifier that merely ends in a keyword is not a block", () => {
  // `myif` ends in "if" and opens no conditional. A substring match would report
  // a barrier as divergent on the strength of a variable's name.
  assert.deepEqual(ids(kernel("    int myif = 1;\n    __syncthreads();\n    out[0] = myif;")), []);
});

test("a barrier named in a comment is not a barrier", () => {
  // The reason every rule runs against a comment-stripped copy. A learner writing
  // a TODO that names the barrier they have not added yet would otherwise be told
  // they had written a divergent barrier.
  assert.deepEqual(ids(kernel("    // TODO: call __syncthreads() here\n    out[0] = 1.0f;")), []);
});

test("a barrier inside a string literal is not a barrier", () => {
  const source = `
__global__ void k(float* out) {
    printf("did not call __syncthreads() here");
    out[0] = 1.0f;
}
`;
  // printf-in-kernel fires here, correctly and irrelevantly, so the assertion is
  // about the barrier rules specifically.
  const reported = ids(source);
  assert.ok(!reported.includes("divergent-barrier"), JSON.stringify(reported));
  assert.ok(!reported.includes("barrier-without-shared"), JSON.stringify(reported));
});

test("a block comment spanning lines does not shift a real barrier's position", () => {
  // The complement of the comment rule: stripping must preserve offsets AND
  // newlines, or a real barrier after a multi-line comment is missed or reported
  // on the wrong line.
  const source = `/* one
two
three */
__global__ void k(float* out) {
    __shared__ float tile[8];
    if (threadIdx.x == 0) {
        __syncthreads();
    }
    out[0] = tile[0];
}
`;
  const rules = lintCuda(source);
  assert.equal(rules.length, 1, JSON.stringify(rules.map((r) => r.id)));
  assert.equal(rules[0].id, "divergent-barrier");
  assert.equal(rules[0].line, 7, "a comment stripper that collapsed newlines would report a different line");
});

test("an unclosed brace is reported at the brace", () => {
  const rules = lintCuda("__global__ void k(float* a) {\n    a[0] = 1.0f;\n");
  const unclosed = rules.find((rule) => rule.id === "unclosed-bracket");
  assert.ok(unclosed !== undefined, JSON.stringify(rules.map((r) => r.id)));
  assert.equal(unclosed.severity, "error");
  assert.equal(unclosed.line, 1);
});

test("a stray closing brace is reported at the brace", () => {
  const rules = lintCuda("void f() {\n}\n}\n");
  assert.ok(rules.some((rule) => rule.id === "unbalanced-closer" && rule.line === 3));
});

test("a mismatched pair names both ends", () => {
  // One message per end, so the squiggle appears on the opener as well as the
  // closer. An unmatched bracket reported only where the reader is not looking is
  // a bracket they have to hunt for.
  const rules = lintCuda("void f() {\n    g(];\n}\n");
  const mismatched = rules.filter((rule) => rule.id === "mismatched-bracket");
  assert.equal(mismatched.length, 2, JSON.stringify(rules.map((r) => r.id)));
  assert.ok(mismatched.some((rule) => rule.line === 2));
});

test("brackets inside a comment are not unbalanced brackets", () => {
  // The other direction: a comment containing a lone brace must not report the
  // file as unbalanced, which is the failure mode of a rule that strips nothing.
  assert.deepEqual(ids(kernel("    // see the } brace in the docs\n    out[0] = 1.0f;")), []);
});

test("a barrier with no __shared__ anywhere is a hint, not a warning", () => {
  // Deliberately the weakest rule in the set: a barrier with nothing to publish
  // is usually a leftover, but it can be correct -- a barrier that only orders
  // memory. Info, which is a different thing in Monaco's Problems panel.
  const rule = only("__global__ void k(float* out) {\n    __syncthreads();\n    out[0] = 1.0f;\n}\n");
  assert.equal(rule.id, "barrier-without-shared");
  assert.equal(rule.severity, "hint");
});

test("printf in a kernel is a hint", () => {
  const rule = only(kernel('    printf("%f\\n", tile[0]);'));
  assert.equal(rule.id, "printf-in-kernel");
  assert.equal(rule.severity, "hint");
});

test("printf in host code is not flagged", () => {
  // The shim maps printf in BOTH places, so flagging host code would be wrong --
  // host printf is the ordinary thing.
  assert.deepEqual(ids('int main() {\n    printf("hi\\n");\n    return 0;\n}\n'), []);
});

test("warpSize is hinted at once per use", () => {
  assert.equal(ids("int f() { return warpSize + warpSize; }\n").filter((id) => id === "warpsize").length, 2);
});

test("the block kinds are in the order the classifier numbers them", () => {
  // The classifier returns an index and the lookup turns it back into a name, so
  // the two arrays have to agree. Reordering one without the other would make
  // every conditional classify as whatever moved into its slot.
  assert.equal(new Set(BLOCK_KINDS).size, BLOCK_KINDS.length, "BLOCK_KINDS has a duplicate");
  for (const kind of ["if", "else", "for", "while", "do", "switch", "function", "block", "struct"]) {
    assert.ok(BLOCK_KINDS.includes(kind), `BLOCK_KINDS is missing ${kind}`);
  }
});

test("every shipped example has no lint ERROR", () => {
  // The strongest false-positive check available: twelve real programs, written
  // before these rules existed, must not light up. Anything they trip is a rule
  // that is wrong rather than a program that is. Warnings and hints are allowed
  // -- those are opinions -- but an error on a program that compiles and runs is
  // the editor telling a learner something false.
  const dir = path.join(repoRoot, "website", "src", "examples");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".cu"));
  assert.ok(files.length >= 12, `only found ${files.length} examples`);
  for (const name of files) {
    const errors = lintCuda(fs.readFileSync(path.join(dir, name), "utf8")).filter((rule) => rule.severity === "error");
    assert.deepEqual(
      errors.map((rule) => `${name}:${rule.line} ${rule.id}`),
      [],
      `${name} reported a lint error, which would be a false positive in a program that compiles and runs`,
    );
  }
});

test("no shipped example is reported as a divergent barrier", () => {
  // Stronger than the error check, and the one that would have caught the
  // loop-vs-conditional bug. Every shipped kernel that uses a barrier uses it the
  // correct way, so any of these is a false positive.
  const dir = path.join(repoRoot, "website", "src", "examples");
  const flagged = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".cu"))) {
    const hits = lintCuda(fs.readFileSync(path.join(dir, name), "utf8")).filter((rule) => rule.id === "divergent-barrier");
    for (const hit of hits) flagged.push(`${name}:${hit.line}`);
  }
  assert.deepEqual(flagged, [], "a shipped example was reported as a divergent barrier");
});

test("the identifier table is deduplicated and sorted", () => {
  // Two tables naming the same intrinsic would offer it twice in completion, and
  // the duplicate is invisible until somebody types the prefix and sees it.
  const names = cudaIdentifiers();
  assert.deepEqual([...new Set(names)], names, "the identifier table has a duplicate");
  assert.deepEqual(names, [...names].sort(), "the identifier table is not sorted");
});

test("a lint marker position indexes the original text", () => {
  // Every rule reports against a comment-stripped copy, so an offset that does not
  // survive the strip points at the wrong line -- which is worse than no marker,
  // because the message is then attached to innocent code.
  const source =
    "// a comment that must not shift the line\n" +
    "__global__ void k(float* out) {\n" +
    "    __shared__ float t[8];\n" +
    "    if (threadIdx.x == 0) {\n" +
    "        __syncthreads();\n" +
    "    }\n" +
    "}\n";
  const rule = only(source);
  assert.equal(rule.line, 5);
  const line = source.split("\n")[rule.line - 1];
  assert.match(line, /__syncthreads/, `line ${rule.line} is ${JSON.stringify(line)}`);
  // And the column, not just the line: the squiggle has to sit on the call. Its
  // span covers the parens too, which is what a reader expects to see underlined.
  const span = line.slice(rule.column - 1, rule.column - 1 + rule.length);
  assert.ok(span.startsWith("__syncthreads"), `the span is ${JSON.stringify(span)}`);
});
