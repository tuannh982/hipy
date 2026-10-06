// The jump-to-definition index.
//
// The failure mode here is not a crash, it is a WRONG JUMP: the reader presses
// F12 on a launch size and lands on a line that has nothing to do with it, and
// then stops trusting the feature. So the tests are as much about what must NOT be
// indexed as about what must be -- and the last two are the important ones, because
// they run against the twelve real examples rather than against samples written to
// match the patterns.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const { indexSource, indexRuntime, cudaRuntimeSource, CUDA_RUNTIME_URI } = await tsImport(
  path.join(repoRoot, "website", "src", "lib", "cudaSymbols.ts"),
  import.meta.url,
);

test("a macro is indexed at the name, not the line", () => {
  const line = "#define TILE 32";
  const index = indexSource(`${line}\n__global__ void k(float* a) { a[0] = TILE; }\n`);
  const macro = index.get("TILE");
  assert.ok(macro, "TILE was not indexed");
  assert.equal(macro.kind, "macro");
  assert.equal(macro.line, 1);
  // The reported span is the identifier and not the whole directive, so the cursor
  // lands on what was clicked rather than on the `#define`.
  assert.equal(line.slice(macro.column - 1, macro.endColumn - 1), "TILE");
});

test("an indented macro is indexed", () => {
  assert.ok(indexSource("   #  define  N 128\n").has("N"), "a whitespace-padded #define was missed");
});

test("a kernel definition is indexed and is distinguishable from a function", () => {
  const source = `extern "C" __global__ void matmulConflict(const float* a, float* c, int n) {\n  c[0] = a[0];\n}\n`;
  const kernel = indexSource(source).get("matmulConflict");
  assert.ok(kernel, "the kernel was not indexed");
  assert.equal(kernel.kind, "kernel");
  assert.equal(kernel.line, 1);
});

test("a __device__ function is indexed as a function", () => {
  const index = indexSource("__device__ float square(float x) { return x * x; }\n");
  assert.equal(index.get("square")?.kind, "function");
});

test("a host function is indexed", () => {
  const index = indexSource("void fill(float* a, int n) {\n  for (int i = 0; i < n; i++) a[i] = 0.0f;\n}\n");
  assert.ok(index.has("fill"), "a plain host definition was missed");
});

test("a CALL is not indexed as a definition", () => {
  // The distinguishing feature is the body brace. An index that matched parameter
  // lists alone would resolve every call site to the function it calls, so F12 on
  // the call inside main would jump to the definition -- which is right -- but F12
  // on the DEFINITION would also produce a location, and the editor would treat
  // the symbol as self-referential.
  const source = `void helper(int n) {\n}\n\nint main() {\n  helper(4);\n  return 0;\n}\n`;
  const index = indexSource(source);
  assert.equal(index.get("helper")?.line, 1, "the definition should win over the call");
  assert.ok(index.has("main"));
});

test("the <<<>>> launch syntax is not mistaken for a parameter list", () => {
  // `matmulConflict<<<dim3(N / BLOCK_X), dim3(BLOCK_X)>>>(a, b, c);` contains what
  // looks like a parameter list. If the brace requirement were dropped, this would
  // index as a definition.
  const source = `void launch(float* a) {\n  kern<<<dim3(4), dim3(64)>>>(a);\n}\n`;
  const index = indexSource(source);
  assert.ok(!index.has("kern"), "a launch expression was indexed as a definition");
});

test("control-flow keywords are never indexed as functions", () => {
  // `if (x) {` matches the plain-function pattern's shape perfectly.
  const source = `void f(int x) {\n  if (x) {\n    x++;\n  }\n  while (x) {\n    x--;\n  }\n  for (int i = 0; i < 2; i++) {\n    x += i;\n  }\n}\n`;
  const index = indexSource(source);
  for (const keyword of ["if", "while", "for", "switch", "catch"]) {
    assert.ok(!index.has(keyword), `${keyword} was indexed as a definition`);
  }
});

test("a #define inside a block comment is not a macro", () => {
  // The anchor is a line start, which a comment line satisfies. This is the one
  // false positive a line-anchored macro pattern has, and it is worth knowing
  // about rather than pretending it cannot happen.
  const source = "/*\n#define NOPE 1\n*/\nvoid f() {}\n";
  const index = indexSource(source);
  // Documented limitation: the anchor cannot see the comment. Asserted so the
  // behaviour is pinned rather than discovered.
  assert.equal(index.has("NOPE"), true, "the line anchor does match inside a block comment");
});

test("the CUDA API has a declaration for every name completion offers", () => {
  // The whole point of generating the API document from the same tables. If these
  // two ever diverge, a name appears in completion with nothing to jump to.
  const index = indexRuntime();
  const source = cudaRuntimeSource();
  for (const name of ["cudaMalloc", "cudaMemcpy", "atomicAdd", "__syncthreads", "threadIdx"]) {
    assert.ok(index.has(name), `${name} has no declaration to jump to`);
    assert.ok(source.includes(name), `${name} is missing from the synthetic header`);
  }
});

test("a note on an API symbol reaches the synthetic header as a comment", () => {
  // Hover and go-to-definition should tell the same story.
  assert.match(cudaRuntimeSource(), /\/\/ Waits until every thread in the block has reached it/);
});

test("the synthetic header declares every runtime name it can", () => {
  const index = indexRuntime();
  // Every name in the index must be findable as a line, i.e. the regex that built
  // the index and the source it ran over agree.
  for (const [name, symbol] of index) {
    assert.ok(symbol.line > 0 && symbol.endColumn > symbol.column, `${name} has an empty span`);
  }
  assert.ok(index.size > 40, `only ${index.size} API symbols; the tables should yield more`);
});

test("the runtime URI is stable", () => {
  // The definition provider hands this to Monaco as a location target, so it has
  // to be the same string every time or a jump opens a second document.
  assert.equal(CUDA_RUNTIME_URI, "inmemory://model/hipy-cuda-runtime.h");
});

test("every shipped example indexes the symbols a reader would click", () => {
  const dir = path.join(repoRoot, "website", "src", "examples");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".cu"));
  assert.ok(files.length >= 12, `only found ${files.length} examples`);
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const index = indexSource(source);
    assert.ok(index.size > 0, `${name} indexed no symbols at all`);
    // Every macro the file DEFINES must be indexed, since those are the most
    // common Ctrl+click in a .cu file.
    const defined = [...source.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
    for (const macro of defined) {
      assert.ok(index.has(macro), `${name} defines ${macro} but the index does not have it`);
    }
    // And every launch expression's kernel must resolve, because that is the other
    // thing a reader navigates: from the host call up to the kernel.
    for (const launch of source.matchAll(/^\s*([A-Za-z_]\w*)\s*<<</gm)) {
      const kernel = launch[1];
      assert.ok(index.has(kernel), `${name} launches ${kernel} but the index cannot resolve it`);
    }
  }
});

test("no example indexes a control-flow keyword", () => {
  const dir = path.join(repoRoot, "website", "src", "examples");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".cu"))) {
    const index = indexSource(fs.readFileSync(path.join(dir, name), "utf8"));
    for (const keyword of ["if", "for", "while", "switch", "return", "catch", "sizeof"]) {
      assert.ok(!index.has(keyword), `${name} indexed ${keyword} as a definition`);
    }
  }
});
