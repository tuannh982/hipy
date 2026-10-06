#include <cuda_runtime.h>

// Histogram with no atomics.
//
// Each thread gets a private row of counters in shared memory and increments only
// its own, so nothing needs an atomic. The map tid / ROWS is what makes that safe:
// every lane owns a distinct row, so no two lanes ever name the same counter. One
// pass afterwards folds the rows into a global count.
//
// The rows are bin-major, rows[value * ROWS + r], so folding a bin sums ROWS
// contiguous counters. The obvious layout strides by BINS instead, and clang pairs
// those reads into a DS_READ2ST32_B64, which is unimplemented (website/README.md).
//
// Values are 0..255 by construction, so every bin must come out equal: a weak test
// of arithmetic, a strong one of shape, since a dropped or doubled increment shows
// up immediately.

#define THREADS 64
#define ROWS 8
#define BINS 256
#define PER_LANE 4
#define TOTAL (THREADS * PER_LANE)

extern "C" __global__ void histogram(int *workspace) {
    // One shared allocation, sliced into private rows then global bins.
    __shared__ int shared[ROWS * BINS + BINS];
    int *rows = shared;
    int *bins = shared + ROWS * BINS;

    const int tid = threadIdx.x;
    const int lane = tid & (ROWS - 1);
    const int row = tid / ROWS;

    if (tid < BINS) bins[tid] = 0;
    if (lane < BINS) rows[row * BINS + lane] = 0;

    const int *in = workspace;
    int *out = workspace + TOTAL;

    for (int i = tid; i < TOTAL; i += THREADS) {
        const int value = in[i] & (BINS - 1);
        rows[value * ROWS + row] = rows[value * ROWS + row] + 1;
    }
    __syncthreads();

    // One pass over the bins: each thread folds a bin's column and sums its
    // private rows. Strided so all 256 bins are covered by 64 threads.
    for (int bin = tid; bin < BINS; bin += THREADS) {
        int total = 0;
        for (int r = 0; r < ROWS; ++r) total += rows[bin * ROWS + r];
        bins[bin] = total;
    }
    __syncthreads();

    for (int bin = tid; bin < BINS; bin += THREADS) out[bin] = bins[bin];
}

int main(void) {
    static int workspace[TOTAL + BINS];
    static int result[BINS];
    int *deviceWorkspace;

    for (int i = 0; i < TOTAL; ++i) workspace[i] = (i * 37) & (BINS - 1);
    for (int bin = 0; bin < BINS; ++bin) workspace[TOTAL + bin] = 0;

    cudaMalloc(&deviceWorkspace, (TOTAL + BINS) * sizeof(int));
    cudaMemcpy(deviceWorkspace, workspace, (TOTAL + BINS) * sizeof(int), cudaMemcpyHostToDevice);

    histogram<<<1, THREADS>>>(deviceWorkspace);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(result, deviceWorkspace + TOTAL, BINS * sizeof(int), cudaMemcpyDeviceToHost);
    int wrong = 0;
    for (int bin = 0; bin < BINS; ++bin) {
        if (result[bin] != TOTAL / BINS) wrong++;
    }
    printf("bins = %d, all == %d: %s\n", BINS, TOTAL / BINS, wrong == 0 ? "yes" : "no");

    cudaFree(deviceWorkspace);
    return 0;
}