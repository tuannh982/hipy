// The Go/host bridge at the only boundary it has: a byte range in the Go instance's
// linear memory, addressed by a pointer that crossed a wasm i32 parameter.
//
// The failure this guards is silent. A Go pointer is an unsigned offset, but
// //go:wasmexport returns it as i32 and wasm sign-extends i32 into JavaScript, so every
// address at or above 0x80000000 arrives negative and is rejected as an out-of-range
// index. It never shows up as a wrong answer: it shows up as a RangeError out of
// whichever call happened to be in flight.
//
// So these drive the real helpers against a real WebAssembly.Memory big enough to
// require the coercion: 36864 pages is 2.25 GiB, and the address used below,
// 0x88a25b40, is one the CDNA3 platform hands out once its ~2.1 GB heap has grown.
// The GCN3 device's stays near 0.3 GB, which is why the same code was correct on gfx803.
// Only the touched pages are committed, so the allocation costs a few megabytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const { goMemoryBytes, goRead, goWrite } = await tsImport(path.join(repoRoot, "website", "src", "lib", "libcudart.ts"), import.meta.url);

// 0x88a25b40 as an i32 is negative: the first statement of the defect.
const ABOVE_2GIB = 0x88a25b40;
const bigMemory = () => new WebAssembly.Memory({ initial: 36864 });
const instanceOf = (memory, exports = {}) => ({ exports: { mem: memory, ...exports } });
const payload = (length, seed = 0) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 0xff);

test("goRead returns the bytes an address above 2 GiB points at", () => {
  const memory = bigMemory();
  const bytes = payload(64, 3);
  new Uint8Array(memory.buffer).set(bytes, ABOVE_2GIB);
  assert.deepEqual([...goRead(instanceOf(memory), ABOVE_2GIB | 0, bytes.length)], [...bytes]);
});

test("goWrite places bytes at the address alloc handed out, above 2 GiB", () => {
  const memory = bigMemory();
  const instance = instanceOf(memory, { alloc: () => ABOVE_2GIB | 0 });
  const bytes = payload(48, 11);
  const ptr = goWrite(instance, bytes);
  assert.equal(ptr, ABOVE_2GIB);
  assert.deepEqual([...goMemoryBytes(memory, ptr, bytes.length)], [...bytes]);
});

test("an address outside memory is refused, and the message names it", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  assert.throws(() => goMemoryBytes(memory, 0x80000000 | 0, 8), /Go memory access at pointer 0x80000000 with length 8 exceeds 65536 bytes/);
  assert.throws(() => goMemoryBytes(memory, 65530, 8), /0xfffa/);
  // Past the end of the 2.25 GiB allocation, so the coercion cannot rescue it: this
  // is a genuinely bad address rather than a large one.
  assert.throws(() => goMemoryBytes(bigMemory(), 0x90000000, 8), /exceeds 2415919104 bytes/);
});