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
const { createLibcudart, goMemoryBytes, goRead, goWrite } = await tsImport(path.join(repoRoot, "website", "src", "lib", "libcudart.ts"), import.meta.url);

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

// The other host import that reads a pointer's worth of caller state: printf.
//
// clang cannot pass wasm varargs as wasm parameters, so it lowers
// `printf(fmt, a, b)` on wasm32 into `printf(fmt, buffer)` -- the second import
// parameter is a pointer to a stack buffer holding the arguments at their natural
// alignment. `clang --target=wasm32 -S` on `printf("out[%d] = %f\n", i, d)`
// emits, verbatim:
//
//     i32.const  16          ; out[%d]
//     local.get  0
//     i32.store              ; offset 0
//     local.get  3
//     local.get  1
//     f64.store 8            ; offset 8, not 4
//
// Four bytes of padding sit between them. A shim that walks the arguments by
// their natural size alone reads the double at offset 4, which is the low word
// of the int and the high word of zero -- 0.0, so the number renders as
// 0.000000. Nothing throws; the figure is simply wrong, which is why this took a
// mixed conversion to find: all sixteen example .cu files print either all-%d or
// all-%.1f, and a homogeneous run has no narrow argument to displace the double.
//
// The buffer is built by hand below rather than compiled, so the layout under
// test is the layout clang emits, stated once and read by every case.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const goRuntimeStub = { importObject: {}, run: async () => {}, exit: () => {} };
const goInstanceStub = { exports: { mem: new WebAssembly.Memory({ initial: 1 }) } };
const FORMAT_PTR = 0x1000;
const VARARGS_PTR = 0x2000;

// A host instance whose memory holds nothing but the two regions printf reads.
const printfOn = () => {
  const hostInstance = { exports: { memory: new WebAssembly.Memory({ initial: 1 }) } };
  const written = [];
  const libcudart = createLibcudart({
    go: goRuntimeStub,
    goInstance: goInstanceStub,
    hostInstance,
    onStdout: (bytes) => written.push(decoder.decode(bytes)),
  });
  const memory = new Uint8Array(hostInstance.exports.memory.buffer);
  const bytes = new DataView(hostInstance.exports.memory.buffer);
  return {
    // `layout` writes the varargs buffer at ARGS, in the order clang would.
    call: (format, layout) => {
      const encoded = encoder.encode(format);
      memory.set(encoded, FORMAT_PTR);
      memory[FORMAT_PTR + encoded.length] = 0;
      layout(bytes, VARARGS_PTR);
      libcudart.printf(FORMAT_PTR, VARARGS_PTR);
      return written.join("");
    },
  };
};

const putI32 = (bytes, ptr, value) => bytes.setInt32(ptr, value, true);
const putF64 = (bytes, ptr, value) => bytes.setFloat64(ptr, value, true);
const putCString = (bytes, ptr, text) => {
  const encoded = encoder.encode(text);
  new Uint8Array(bytes.buffer).set(encoded, ptr);
  new Uint8Array(bytes.buffer)[ptr + encoded.length] = 0;
};

test("printf reads a double that follows a narrow argument from its aligned offset", () => {
  const { call } = printfOn();
  // The clang layout above: i32 at 0, f64 at 8. Reading sequentially instead
  // takes the double at 4 and prints 0.000000.
  assert.equal(
    call("out[%d] = %f\n", (bytes, args) => {
      putI32(bytes, args, 0);
      putF64(bytes, args + 8, 42);
    }),
    "out[0] = 42.000000\n",
  );
});

test("printf reads a double that is the first argument without shifting it", () => {
  const { call } = printfOn();
  // Alignment must be relative to where the buffer already is, not relative to
  // the first conversion: the buffer base is 16-byte aligned because the wasm
  // stack pointer is, so aligning here is a no-op rather than a shift of 4.
  assert.equal(
    call("%f\n", (bytes, args) => {
      putF64(bytes, args, 42);
    }),
    "42.000000\n",
  );
});

test("printf reads a double that follows two narrow arguments without shifting it", () => {
  const { call } = printfOn();
  // Two i32s put the cursor at offset 8, which is already the boundary the
  // double needs, so padding is inserted only by an odd number of them.
  assert.equal(
    call("%d %d %f\n", (bytes, args) => {
      putI32(bytes, args, 3);
      putI32(bytes, args + 4, 4);
      putF64(bytes, args + 8, 7.5);
    }),
    "3 4 7.500000\n",
  );
});

test("printf reads a narrow argument that follows a double", () => {
  const { call } = printfOn();
  // The other direction: the double occupies 8 bytes, so the int after it is at 8.
  // A rule that inserted padding *after* every narrow argument would put it at 12.
  assert.equal(
    call("%f %d\n", (bytes, args) => {
      putF64(bytes, args, 1.5);
      putI32(bytes, args + 8, 9);
    }),
    "1.500000 9\n",
  );
});

test("printf reads two doubles in a row", () => {
  const { call } = printfOn();
  assert.equal(
    call("%f %f\n", (bytes, args) => {
      putF64(bytes, args, 1.5);
      putF64(bytes, args + 8, 2.25);
    }),
    "1.500000 2.250000\n",
  );
});

test("printf keeps reading a homogeneous run of narrow arguments", () => {
  const { call } = printfOn();
  assert.equal(
    call("%d %d %d\n", (bytes, args) => {
      putI32(bytes, args, 10);
      putI32(bytes, args + 4, 11);
      putI32(bytes, args + 8, 12);
    }),
    "10 11 12\n",
  );
});

test("printf reads every narrow conversion at the width it occupies", () => {
  const { call } = printfOn();
  // A homogeneous run, one of each narrow conversion. %s takes a pointer, so its
  // argument is an address rather than a value, and %c promotes a char to int.
  assert.equal(
    call("%d %s %c %x %X %o %u %i %%|\n", (bytes, args) => {
      putCString(bytes, 0x3000, "hi");
      putI32(bytes, args, -5);
      putI32(bytes, args + 4, 0x3000);
      putI32(bytes, args + 8, 65);
      putI32(bytes, args + 12, 255);
      putI32(bytes, args + 16, 255);
      putI32(bytes, args + 20, 8);
      putI32(bytes, args + 24, 4294967295);
      putI32(bytes, args + 28, 7);
    }),
    "-5 hi A ff FF 10 4294967295 7 %|\n",
  );
});
