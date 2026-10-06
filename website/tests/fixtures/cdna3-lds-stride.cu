// Strided LDS reads into contiguous writes on CDNA3, in isolation from any shipping
// example. The address register for this access is v0, written by
// v_mad_i32_i24 v0, v0, s4, v1 where s4 comes from `s_movk_i32 s4, 0xffe4`; cdna3's
// s_movk_i32 must widen the int16 sign-extended, as gcn3's does, or the product loses
// 0x10000 per unit of the lane id and the address reads back as
// (lane << 16) | byte_offset.
//
// Guard the corners: with ROWS=2 (8-byte stride) a broken s_movk_i32 still passes here.
//
// NOT a test, and deliberately so: no suite runs this file. It prints nothing and
// compares nothing. ops-memory covers the same access shape on both ISAs and is
// compared element by element against histogramExpected in tests/lib/cpu-reference.mjs.
// What this file adds is the doubled __syncthreads and the ROWS*BINS+1 LDS footprint,
// so a corrupted address register surfaces as an LDS size violation rather than as a
// wrong total. The header's "passes on both gfx803 and gfx942" is a note about a manual
// run, not a claim any suite checks.
#include <cuda_runtime.h>
#define THREADS 32
#define ROWS 8
#define BINS 32
extern "C" __global__ void k(int *w) {
    __shared__ int shared[ROWS * BINS + BINS];
    int *rows = shared;
    int *bins = shared + ROWS * BINS;
    int *out = w + BINS;
    const int tid = threadIdx.x;
    const int row = tid / ROWS;
    if (tid < BINS) bins[tid] = 0;
    __syncthreads();
    for (int i = tid; i < 2 * BINS; i += THREADS) {
        const int value = w[i] & (BINS - 1);
        rows[value * ROWS + row] = rows[value * ROWS + row] + 1;
    }
    __syncthreads();
    __syncthreads();
    for (int bin = tid; bin < BINS; bin += THREADS) {
        bins[bin] = rows[bin * ROWS];
    }
    __syncthreads();
    for (int bin = tid; bin < BINS; bin += THREADS) out[bin] = bins[bin];
}
int main(void) {
    static int w[2 * BINS]; int *d;
    for (int i = 0; i < 2 * BINS; i++) w[i] = i * 5 + 1;
    cudaMalloc(&d, 2 * BINS * sizeof(int));
    cudaMemcpy(d, w, 2 * BINS * sizeof(int), cudaMemcpyHostToDevice);
    k<<<1, THREADS>>>(d);
    cudaGetLastError(); cudaDeviceSynchronize();
    static int r[BINS];
    cudaMemcpy(r, d + BINS, BINS * sizeof(int), cudaMemcpyDeviceToHost);
    int s = 0; for (int i = 0; i < BINS; i++) s += r[i];

    return 0;
}
