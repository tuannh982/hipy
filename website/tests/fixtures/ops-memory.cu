// Memory access coverage: the shapes of global and shared access the other fixtures
// depend on, isolated so a regression in one is attributable.
//
// The shared-memory cases are the ones that matter. A paired LDS read is what clang
// emits for a 2-address access at constant stride, and which opcodes exist differs
// between gfx803 and gfx942, so each pattern is named rather than left implicit:
//
//   thread-derived    tile[tid]           contiguous between lanes
//   data-dependent    tile[value]         index comes from a loaded value
//   2-D contiguous    tile[bin * ROWS + r]  consecutive in r, one row per lane
//   2-D padded        same, stride + 1    breaks the 128-byte bank row
//   strided read      rows[bin * ROWS]    32 bytes between lanes, read to a
//                                        contiguous write -- the shape whose
//                                        address depends on a negative s_movk_i32
//                                        immediate, so it caught that fault
//
// The last one is why this file exists as a fixture rather than only inside
// matmul: it is the only case in the tree that separates the two ISAs. It did so
// for one release -- the strided read was correct on gfx803 and broken on gfx942 --
// and the fault it found was not in LDS at all but in cdna3's s_movk_i32, which
// dropped the sign extension of a negative 16-bit immediate. Both ISAs agree now.
#include <cuda_runtime.h>

#define THREADS 32
#define ROWS 8
#define BINS 32
#define TILE 64

extern "C" __global__ void opsMemory(int *w) {
    __shared__ int tile[TILE];
    __shared__ int shared[ROWS * BINS + BINS];
    int *rows = shared;
    int *bins = shared + ROWS * BINS;
    int *out = w + TILE + ROWS * BINS + BINS;

    const int tid = threadIdx.x;
    for (int i = tid; i < TILE; i += THREADS) tile[i] = w[i];      // coalesced global read
    if (tid < BINS) bins[tid] = 0;
    for (int i = tid; i < ROWS * BINS; i += THREADS) rows[i] = 0;
    __syncthreads();

    int r = 0;

    // Thread-derived shared index: contiguous between lanes.
    r += tile[tid];

    // Data-dependent shared index, from a value loaded out of global memory.
    r += tile[w[tid] & (TILE - 1)];

    // Two-dimensional contiguous: consecutive in r, one row per lane.
    for (int r2 = 0; r2 < ROWS; ++r2) r += rows[tid * ROWS + r2];

    // Strided read feeding a contiguous write. This is the shape that differs
    // between gfx803 and gfx942.
    bins[tid] = rows[tid * ROWS];

    __syncthreads();
    r += bins[tid];

    // Global write, and a global read at a stride rather than coalesced.
    out[tid] = r + w[(tid * 3) & (TILE - 1)];

    // Unaligned-by-stride shared read, one element per lane but stepped by 3.
    r += tile[(tid * 3) & (TILE - 1)] * 0; // keep the shape without changing r
    __syncthreads();
    out[THREADS + tid] = r;
}

int main(void) {
    const int total = TILE + ROWS * BINS + BINS + 2 * THREADS;
    static int w[1024];
    int *dw;

    for (int i = 0; i < total; ++i) w[i] = (i * 37 + 11) & 63;

    cudaMalloc(&dw, 1024 * sizeof(int));
    cudaMemset(dw, 0, 1024 * sizeof(int));
    cudaMemcpy(dw, w, total * sizeof(int), cudaMemcpyHostToDevice);

    opsMemory<<<1, THREADS>>>(dw);
    cudaGetLastError();
    cudaDeviceSynchronize();

    static int r[1024];
    cudaMemcpy(r, dw, total * sizeof(int), cudaMemcpyDeviceToHost);
    for (int i = 0; i < 2 * THREADS; ++i) printf("%d\n", r[TILE + ROWS * BINS + BINS + i]);

    cudaFree(dw);
    return 0;
}