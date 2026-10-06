#include <cuda_runtime.h>
#define COMPACT_THREADS 32
#define COMPACT_BLOCKS 4
#define COMPACT_N (COMPACT_THREADS * COMPACT_BLOCKS)
#define COMPACT_STATE (COMPACT_BLOCKS + 1)
// Every sixteenth element survives, so 64 of COMPACT_N.
#define COMPACT_COUNT (COMPACT_N / 16)

extern "C" __global__ void countMatches(const float *input, int *state) {
    __shared__ int tile[COMPACT_THREADS];

    int matches = 0;
    for (int i = blockIdx.x * COMPACT_THREADS + threadIdx.x; i < COMPACT_N; i += COMPACT_THREADS * COMPACT_BLOCKS) {
        if (((int)input[i] & 15) == 0) matches++;
    }

    tile[threadIdx.x] = matches;
    __syncthreads();

    for (int stride = COMPACT_THREADS / 2; stride > 0; stride /= 2) {
        if (threadIdx.x < stride) tile[threadIdx.x] += tile[threadIdx.x + stride];
        __syncthreads();
    }

    if (threadIdx.x == 0) state[blockIdx.x] = tile[0];
}

// Exclusive scan of the per-block counts: how many matches came before this block.

extern "C" __global__ void scanCounts(int *state) {
    __shared__ int tile[COMPACT_BLOCKS];

    const int tid = threadIdx.x;
    tile[tid] = state[tid];
    const int own = state[tid];
    __syncthreads();

    // Hillis-Steele, 4 rounds, block sized to the data so no bounds test.
    for (int stride = 1; stride < COMPACT_BLOCKS; stride *= 2) {
        int running = tile[tid];
        if (tid >= stride) running += tile[tid - stride];
        __syncthreads();
        tile[tid] = running;
        __syncthreads();
    }

    // Exclusive = inclusive minus this count's own.
    state[tid] = tile[tid] - own;
    if (tid == COMPACT_BLOCKS - 1) state[COMPACT_BLOCKS] = tile[tid];
}

extern "C" __global__ void compact(const float *input, float *output, const int *state) {
    __shared__ int tile[COMPACT_THREADS];

    const int i = blockIdx.x * COMPACT_THREADS + threadIdx.x;
    const int matched = (((int)input[i] & 15) == 0) ? 1 : 0;

    // Inclusive scan of the block's 64 flags.
    tile[threadIdx.x] = matched;
    __syncthreads();
    for (int stride = 1; stride < COMPACT_THREADS; stride *= 2) {
        int running = tile[threadIdx.x];
        if (threadIdx.x >= stride) running += tile[threadIdx.x - stride];
        __syncthreads();
        tile[threadIdx.x] = running;
        __syncthreads();
    }

    if (matched) {
        const int position = state[blockIdx.x] + tile[threadIdx.x] - 1;
        output[position] = input[i];
    }
}

int main(void) {
    static float input[COMPACT_N];
    static float output[COMPACT_N];
    static int state[COMPACT_STATE];
    float *deviceInput;
    float *deviceOutput;
    int *deviceState;

    for (int i = 0; i < COMPACT_N; ++i) input[i] = (float)i;

    cudaMalloc(&deviceInput, COMPACT_N * sizeof(float));
    cudaMalloc(&deviceOutput, COMPACT_N * sizeof(float));
    cudaMalloc(&deviceState, COMPACT_STATE * sizeof(int));
    cudaMemcpy(deviceInput, input, COMPACT_N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(deviceOutput, 0, COMPACT_N * sizeof(float));
    cudaMemset(deviceState, 0, COMPACT_STATE * sizeof(int));

    countMatches<<<COMPACT_BLOCKS, COMPACT_THREADS>>>(deviceInput, deviceState);
    cudaGetLastError();
    cudaDeviceSynchronize();

    scanCounts<<<1, COMPACT_BLOCKS>>>(deviceState);
    cudaGetLastError();
    cudaDeviceSynchronize();

    compact<<<COMPACT_BLOCKS, COMPACT_THREADS>>>(deviceInput, deviceOutput, deviceState);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(output, deviceOutput, COMPACT_N * sizeof(float), cudaMemcpyDeviceToHost);
    cudaMemcpy(state, deviceState, COMPACT_STATE * sizeof(int), cudaMemcpyDeviceToHost);

    // The count, then the two ends. The count is the other half of what compaction
    // is for: a dense output whose length nobody knows is only half written. It gets
    // its own line because mixing %d and %.1f in one call loses arguments here.
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    printf("%d\n", state[COMPACT_BLOCKS]);
    for (int i = 0; i < COMPACT_COUNT; ++i) printf("%.1f\n", output[i]);

    cudaFree(deviceInput);
    cudaFree(deviceOutput);
    cudaFree(deviceState);
    return 0;
}