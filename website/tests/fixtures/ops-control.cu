// Control flow coverage: the branch and loop shapes the other fixtures rely on.
//
// The emulator splits a wavefront at every branch, so a lane's path through a
// divergent region decides which lanes reach a store. That is invisible until
// something is wrong, so each shape is exercised here on its own:
//
//   early return        a lane leaves before its neighbours finish
//   divergent branch    lanes take different sides of an if
//   lane-dependent loop a trip count that differs per lane
//   uniform loop        every lane runs the same trip count, the easy case
//   nested loop         a uniform outer, divergent inner
//   short-circuit       && and ||, which must not evaluate the right-hand side
//   conditional select  the ternary, both spellings
//
// N is small on purpose: the point is which lanes reach a store, not throughput.
#include <cuda_runtime.h>

#define THREADS 32

extern "C" __global__ void opsControl(int *w) {
    int *out = w + 8 * THREADS;
    const int tid = threadIdx.x;
    int r = 0;

    if (tid >= THREADS) return; // never taken here, but the shape is compiled

    // Divergent branch: lanes split on parity.
    if (tid & 1) {
        r += 3;
    } else {
        r += 5;
    }

    // Lane-dependent trip count: lane t runs t iterations.
    for (int k = 0; k < tid; ++k) r += 1;

    // Uniform trip count.
    for (int k = 0; k < 4; ++k) r += 2;

    // Nested: uniform outer, divergent inner.
    for (int k = 0; k < 2; ++k) {
        for (int j = 0; j <= (tid & 3); ++j) r += 1;
    }

    // Short circuit: the right side is only evaluated when it can change the result.
    const bool both = (tid > 4) && (tid < 100);
    const bool either = (tid < 2) || (tid > 30);
    r += both ? 100 : 200;
    r += either ? 1000 : 2000;

    // Ternary on both sides.
    r += (tid & 1) ? 7 : 11;

    // A branch that only some lanes take, with a store inside it.
    if (tid < THREADS / 2) out[tid] = r;

    // Early return from the middle of the work, which must not disturb the others.
    if (tid == 0) { out[THREADS] = r; return; }

    out[THREADS + 1 + tid] = r;
}

int main(void) {
    // 65 slots: out[0..15] from the first half, out[32] from the lane that
    // returns early, the gap at out[33], and out[34..64] from the rest.
    const int total = 8 * THREADS + 2 * THREADS + 1;
    static int w[1024];
    int *dw;

    cudaMalloc(&dw, 1024 * sizeof(int));
    cudaMemset(dw, 0, 1024 * sizeof(int));

    opsControl<<<1, THREADS>>>(dw);
    cudaGetLastError();
    cudaDeviceSynchronize();

    static int r[1024];
    cudaMemcpy(r, dw, total * sizeof(int), cudaMemcpyDeviceToHost);
    for (int i = 0; i < 2 * THREADS + 1; ++i) printf("%d\n", r[8 * THREADS + i]);

    cudaFree(dw);
    return 0;
}