#include <cuda_runtime.h>
#define THREADS 32
#define ROWS 8
#define BINS 32
#define PER_LANE 2
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
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < BINS; ++i) printf("%d\n", result[i]);

    cudaFree(deviceWorkspace);
    return 0;
}