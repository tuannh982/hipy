#include <cuda_runtime.h>
#define RADIX_N 64
#define RADIX_THREADS 32
#define RADIX_BINS 16
#define RADIX_PASSES 2

extern "C" __global__ void radixSort(int *workspace) {
    // One shared allocation, sliced. The per-thread digit counts are bin-major,
    // mine[digit * THREADS + tid], so folding one bin is a contiguous read.
    __shared__ int scratch[2 * RADIX_N + RADIX_THREADS * RADIX_BINS + 2 * RADIX_BINS];
    int *keys = scratch;
    int *alt = scratch + RADIX_N;
    int *mine = scratch + 2 * RADIX_N;
    int *counts = scratch + 2 * RADIX_N + RADIX_THREADS * RADIX_BINS;
    int *offsets = counts + RADIX_BINS;

    const int tid = threadIdx.x;
    int *out = workspace + RADIX_N;

    for (int i = tid; i < RADIX_N; i += RADIX_THREADS) keys[i] = workspace[i];
    for (int k = tid; k < RADIX_THREADS * RADIX_BINS; k += RADIX_THREADS) mine[k] = 0;
    __syncthreads();

    for (int pass = 0; pass < RADIX_PASSES; ++pass) {
        const int shift = pass * 4;
        for (int k = tid; k < RADIX_THREADS * RADIX_BINS; k += RADIX_THREADS) mine[k] = 0;
        __syncthreads();

        for (int i = tid; i < RADIX_N; i += RADIX_THREADS) {
            const int digit = (keys[i] >> shift) & (RADIX_BINS - 1);
            mine[digit * RADIX_THREADS + tid] = mine[digit * RADIX_THREADS + tid] + 1;
        }
        __syncthreads();

        // One thread per bin.
        if (tid < RADIX_BINS) {
            int total = 0;
            for (int t = 0; t < RADIX_THREADS; ++t) total += mine[tid * RADIX_THREADS + t];
            counts[tid] = total;
        }
        __syncthreads();

        // Inclusive scan, then step back by each bin's count to make it exclusive.
        if (tid < RADIX_BINS) offsets[tid] = counts[tid];
        __syncthreads();
        for (int stride = 1; stride < RADIX_BINS; stride *= 2) {
            const int add = (tid >= stride && tid < RADIX_BINS) ? offsets[tid - stride] : 0;
            __syncthreads();
            if (tid < RADIX_BINS) offsets[tid] = offsets[tid] + add;
            __syncthreads();
        }
        if (tid < RADIX_BINS) offsets[tid] = offsets[tid] - counts[tid];
        __syncthreads();

        for (int i = tid; i < RADIX_N; i += RADIX_THREADS) {
            const int digit = (keys[i] >> shift) & (RADIX_BINS - 1);
            int rank = 0;
            for (int j = 0; j < i; ++j) {
                if (((keys[j] >> shift) & (RADIX_BINS - 1)) == digit) rank++;
            }
            alt[offsets[digit] + rank] = keys[i];
        }
        __syncthreads();

        for (int i = tid; i < RADIX_N; i += RADIX_THREADS) keys[i] = alt[i];
        __syncthreads();
    }

    for (int i = tid; i < RADIX_N; i += RADIX_THREADS) out[i] = keys[i];
}

int main(void) {
    static int workspace[2 * RADIX_N];
    static int result[RADIX_N];
    int *deviceWorkspace;

    unsigned int state = 12345u;
    for (int i = 0; i < RADIX_N; ++i) workspace[i] = i;
    for (int i = RADIX_N - 1; i > 0; --i) {
        state = state * 1103515245u + 12345u;
        const int j = (int)((state >> 16) % (unsigned int)(i + 1));
        const int swap = workspace[i];
        workspace[i] = workspace[j];
        workspace[j] = swap;
    }
    for (int i = 0; i < RADIX_N; ++i) workspace[RADIX_N + i] = 0;

    cudaMalloc(&deviceWorkspace, 2 * RADIX_N * sizeof(int));
    cudaMemcpy(deviceWorkspace, workspace, 2 * RADIX_N * sizeof(int), cudaMemcpyHostToDevice);

    radixSort<<<1, RADIX_THREADS>>>(deviceWorkspace);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(result, deviceWorkspace + RADIX_N, RADIX_N * sizeof(int), cudaMemcpyDeviceToHost);
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < RADIX_N; ++i) printf("%d\n", result[i]);

    cudaFree(deviceWorkspace);
    return 0;
}