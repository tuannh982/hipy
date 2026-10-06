// CPU references for the mirrors in website/tests/fixtures.
//
// Ordinary JavaScript implementations of what each kernel computes. No CUDA, no
// simulator, nothing shared with the .cu files: the value of a correctness suite is
// an answer derived independently, so importing the implementation under test would
// defeat it.
//
// Each reference reproduces the fixture's input generation exactly -- same constants,
// same LCG, same seed -- and then computes the result the obvious way: a running
// total for a scan, Array#sort for a sort, a triple loop for a multiply. If a kernel
// is wrong, the naive version is right, and comparing every element is what catches
// it.

// The fixtures build their data with a 32-bit LCG. JS has no unsigned 32-bit
// arithmetic, so Math.imul plus >>> 0 reproduces the wraparound and >>> gives the
// logical shift C's >> performs on an unsigned.
export function lcgShuffle(values, seed) {
  const out = values.slice();
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const j = (state >>> 16) % (i + 1);
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

export const TOLERANCE = 1e-4;

const range = (n) => Array.from({ length: n }, (_, i) => i);

// reduction.cu mirror: 32 threads * 8 blocks * 2 rounds = 512 elements, input[i] = i.
export const reduction = { threads: 32, blocks: 8, rounds: 2 };
reduction.n = reduction.threads * reduction.blocks * reduction.rounds;
export function reductionExpected() {
  return [range(reduction.n).reduce((total, value) => total + value, 0)];
}

// prefixsum.cu mirror: 32-wide tiles over 4 blocks = 128 elements, input[i] = i + 1,
// printed as an exclusive prefix sum.
export const prefixsum = { tile: 32, blocks: 4 };
prefixsum.n = prefixsum.tile * prefixsum.blocks;
export function prefixSumExpected() {
  const exclusive = [];
  let running = 0;
  for (let i = 0; i < prefixsum.n; i++) {
    exclusive.push(running);
    running += i + 1;
  }
  return exclusive;
}

// stream_compaction.cu mirror: 128 elements, input[i] = i, keeping multiples of 16.
// The first dumped value is the count the scan produced, then the survivors.
export const compaction = { threads: 32, blocks: 4, modulus: 16 };
compaction.n = compaction.threads * compaction.blocks;
export function compactionExpected() {
  const kept = range(compaction.n).filter((value) => value % compaction.modulus === 0);
  return [kept.length, ...kept];
}

// topk-rank.cu and topk-bisect.cu mirrors: a permutation of 0..63 shuffled with seed
// 12345, largest k = 4. Both compared in full, so the two middle values are covered.
export const topk = { n: 64, k: 4, seed: 12345 };
export function topKExpected() {
  return lcgShuffle(range(topk.n), topk.seed).sort((a, b) => b - a).slice(0, topk.k);
}

// histogram.cu mirror: (i * 37) & 31 over 64 values. 37 is odd so it is a bijection
// onto 0..31 and every bin is hit twice.
export const histogram = { total: 64, bins: 32, multiplier: 37 };
export function histogramExpected() {
  const counts = new Array(histogram.bins).fill(0);
  for (let i = 0; i < histogram.total; i++) counts[(i * histogram.multiplier) & (histogram.bins - 1)]++;
  return counts;
}

// radixsort.cu mirror: the same permutation, sorted ascending.
export const radix = { n: 64, seed: 12345 };
export function radixExpected() {
  return lcgShuffle(range(radix.n), radix.seed).sort((a, b) => a - b);
}

// bitonicsort.cu mirror: a permutation of 0..63 too, but with its own seed, so a
// reference with the shuffle subtly wrong cannot pass both this and the top-k pair.
export const bitonic = { n: 64, seed: 987654321 };
export function bitonicExpected() {
  return lcgShuffle(range(bitonic.n), bitonic.seed).sort((a, b) => a - b);
}

// The four matmul mirrors: N = 16, a filled with 1 and b with 2. The multiply is done
// rather than hard-coded, so a fixture whose inputs changed would be caught.
export const matmul = { n: 16, aValue: 1, bValue: 2 };
export function matmulExpected() {
  const { n, aValue, bValue } = matmul;
  const c = new Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += aValue * bValue;
      c[row * n + col] = sum;
    }
  }
  return c;
}
// --- operation coverage ------------------------------------------------------
// The three ops-* fixtures isolate the scalar, memory and control-flow shapes the
// example mirrors use, so a regression in one is attributable. Each computes the
// same expression sequence in JS that the kernel computes in CUDA, and the test
// compares all of it.

// ops-arith.cu. The kernel folds twenty-one operations into one int per lane, which
// is what makes the fixture able to say "arithmetic broke" rather than "a sum is
// wrong" -- any single op changing shows up in exactly the lanes it applies to.
export const opsArith = { n: 64 };

export function opsArithExpected() {
  const ints = [];
  const floats = [];
  for (let i = 0; i < opsArith.n; i++) {
    const u = (Math.imul(i, 2654435761) + 12345) >>> 0;
    const a = ((u >>> 8) | 0) - 4096; // (int)(u >> 8) - 4096, in 32-bit two's complement
    const b = (i & 7) - 4;
    const la = BigInt(a) * 3n;
    const lb = BigInt(b) * 5n;

    let r = 0;
    r = (r + a + b) | 0;
    r = (r - (a - b)) | 0;
    r = (r + Math.imul(a, b)) | 0;
    r = r ^ (a & b);
    r = r ^ (a | b);
    r = r ^ (a ^ b);
    r = r ^ ~b;
    r = r ^ (a >> 3);
    r = r ^ (((a << 3) | 0) >>> 0) | 0;
    r = r ^ (a >> (i & 7));
    r = r ^ (a < b ? 1 : 2);
    r = r ^ (a >= b ? 4 : 8);
    r = r ^ (a === b ? 16 : 32);
    r = r ^ Number((la + lb) & 0xffffffffn) | 0;
    r = r ^ Number((la * lb) & 0xffffffffn) | 0;
    r = r ^ Number((la >> 2n) & 0xffffffffn) | 0;
    r = r ^ ((a & 1) === 0 ? 64 : 0);
    r = r ^ (-a);
    r = r ^ (a >> 31);
    ints.push(r | 0);

    const fa = Math.fround(a * 0.5);
    const fb = Math.fround(b * 0.25);
    let fr = 0;
    fr = Math.fround(fr + Math.fround(fa + fb));
    fr = Math.fround(fr - Math.fround(fa - fb));
    fr = Math.fround(fr * Math.fround(fa * fb));
    fr = Math.fround(fr + (fa > fb ? fa : fb));
    fr = Math.fround(fr + (fa < fb ? fa : fb));
    fr = Math.fround(fr + (a > b ? 1 : 0));
    fr = Math.fround(fr + (fa === fb ? 0.5 : 0.25));
    fr = Math.fround(fr + Math.fround(-a));
    floats.push(fr);
  }
  return [...ints, ...floats];
}

// ops-memory.cu. w[] holds (i * 37 + 11) & 63 for every element, which is what the
// data-dependent index and the strided read are keyed on.
export const opsMemory = { threads: 32, rows: 8, bins: 32, tile: 64 };

export function opsMemoryExpected() {
  const { threads, rows, bins } = opsMemory;
  const size = opsMemory.tile;
  const w = range(1024).map((i) => (i * 37 + 11) & 63);
  // The kernel fills tile from w and zeroes both row arrays, so rows and bins read
  // back zero and only tile contributes. That is deliberate: this fixture is about
  // which addresses are read, not about the totals a fold would produce.
  const tile = w.slice(0, size);
  const shared = new Array(rows * bins).fill(0);
  const first = [];
  const second = [];
  for (let tid = 0; tid < threads; tid++) {
    let r = tile[tid];                            // thread-derived
    r += tile[w[tid] & (size - 1)];               // data-dependent
    for (let r2 = 0; r2 < rows; r2++) r += shared[tid * rows + r2];
    r += shared[tid * rows];                      // strided read into a contiguous write
    first.push((r + w[(tid * 3) & (size - 1)]) | 0);
    second.push(r | 0);
  }
  return [...first, ...second];
}

// cdna3-mov-b64.cu. Every lane holds a row of ROW values, (lane + 1) * 2^40 +
// (i + 1), and the kernel walks the row keeping the previous and current value, then
// writes both back over the row's first two slots. The reference returns each of
// those two values as its high and low 32-bit halves, interleaved the way the fixture
// prints them -- one high word per line, then its low word.
//
// BigInt throughout, because these values do not fit in a JS double's exact integer
// range, and a reference that rounds them would agree with a kernel that is wrong.
export const cdna3MovB64 = { threads: 32, row: 8, shift: 40 };

export function cdna3MovB64Expected() {
  const { threads, row, shift } = cdna3MovB64;
  const out = [];
  for (let lane = 0; lane < threads; lane++) {
    const value = (i) => (BigInt(lane + 1) << BigInt(shift)) + BigInt(i + 1);
    for (const v of [value(row - 2), value(row - 1)]) {
      out.push(Number(v >> 32n), Number(v & 0xffffffffn));
    }
  }
  return out;
}

// ops-control.cu.
export const opsControl = { threads: 32 };

export function opsControlExpected() {
  const { threads } = opsControl;
  // Two output regions, and the gap between them is the point. Lane 0 returns early
  // after writing out[threads], so out[threads + 1] is never written by anyone and
  // stays at the memset value -- which is why second[] has a literal 0 in it rather
  // than a lane's total.
  const first = new Array(threads).fill(0); // only the first half of the lanes write here
  const second = new Array(threads + 1).fill(0);
  for (let tid = 0; tid < threads; tid++) {
    let r = 0;
    r += tid & 1 ? 3 : 5;
    r += tid; // the lane-dependent loop runs tid times
    r += 8; // 4 iterations of +2
    for (let k = 0; k < 2; k++) r += (tid & 3) + 1;
    r += tid > 4 && tid < 100 ? 100 : 200;
    r += tid < 2 || tid > 30 ? 1000 : 2000;
    r += tid & 1 ? 7 : 11;
    if (tid < threads / 2) first[tid] = r;
    if (tid === 0) { second[0] = r; continue; }
    second[1 + tid] = r;
  }
  return [...first, ...second];
}
