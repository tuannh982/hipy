// v_mov_b64, the instruction CDNA3 emits and MGPUSim's decode table lacked.
//
// topk-bisect exercises this instruction too, but only fails if nothing else breaks
// first, so the instruction gets a fixture of its own.
//
// Two things are load-bearing and both were arrived at by disassembling:
//
//   The move must carry data, not an address. A mis-decode as the neighbouring
//   v_movrelsd_b32 copies the low word and leaves the high word stale, and a stale
//   VGPR reads 0 -- which is the correct high word for an address below 4 GiB. So
//   prev = cur below moves a value whose high word is a function of the lane, and a
//   stale high word cannot be the right one by accident.
//
//   The copy must not be elidable. clang folds a wide copy with one source and one
//   destination, and unrolls a walk whose trip count it knows. prev and cur are both
//   live across the loop, and the trip count is read from memory, so the register
//   allocator has to materialise the pair. Verified against clang's own assembly for
//   gfx942:
//
//       v_mov_b64_e32 v[0:1], v[2:3]    ; prev = cur, the move under test
//
//   That dependency is CHECKED, not just noted: correctness.test.mjs decodes this
//   fixture's code object on both ISAs and fails if the gfx942 one carries no
//   v_mov_b64, or if the gfx803 one does. A clang that started coalescing the wide
//   copy into two 32-bit moves would otherwise leave this fixture testing nothing
//   while every test stayed green.
//
// gfx803 never emits v_mov_b64 -- LLVM gates the instruction on gfx940+ -- so there
// this is a plain scan of the last two values in a row, and the same reference holds.
#include <cuda_runtime.h>

#define THREADS 32
#define ROW 8
#define TABLE (THREADS + 1)            /* rowOffsets[THREADS], then rowLength */
#define DATA (TABLE + ROW * THREADS)   /* row i starts at DATA + i * ROW */

extern "C" __global__ void movB64(unsigned long long *w) {
    const int tid = threadIdx.x;
    const int n = (int)w[THREADS];

    // A 64-bit address in a register pair: the offset is read, not computed, so the
    // add cannot be narrowed to a 32-bit displacement.
    unsigned long long *row = w + w[tid];

    unsigned long long prev = row[0];
    unsigned long long cur = 0;
    for (int i = 1; i < n; ++i) {
        prev = cur;
        cur = row[i];
    }
    row[0] = prev;
    row[1] = cur;
}

int main(void) {
    static unsigned long long w[DATA + ROW * THREADS];
    unsigned long long *d;

    // Per-lane values (lane + 1) * 2^40 + (i + 1): the high 32 bits are a function of
    // the lane and the low 32 bits a function of the column, which is what makes a
    // stale high word visible as itself rather than as a plausible total.
    for (int lane = 0; lane < THREADS; lane++) {
        w[lane] = DATA + lane * ROW;
        for (int i = 0; i < ROW; i++) {
            w[DATA + lane * ROW + i] = ((unsigned long long)(lane + 1) << 40) + (unsigned long long)(i + 1);
        }
    }
    w[THREADS] = ROW;

    cudaMalloc(&d, sizeof(w));
    cudaMemcpy(d, w, sizeof(w), cudaMemcpyHostToDevice);

    movB64<<<1, THREADS>>>(d);
    cudaGetLastError();
    cudaDeviceSynchronize();

    // Two results per lane, written back over the row's first two slots.
    static unsigned long long r[ROW * THREADS];
    cudaMemcpy(r, d + DATA, sizeof(r), cudaMemcpyDeviceToHost);

    // Both halves of each result, one per line: the harness reads printed numbers, and
    // a wrong high word is only legible as its own word.
    for (int lane = 0; lane < THREADS; lane++) {
        for (int k = 0; k < 2; k++) {
            const unsigned long long v = r[lane * ROW + k];
            printf("%d\n", (int)(v >> 32));
            printf("%d\n", (int)(unsigned int)v);
        }
    }
    return 0;
}
