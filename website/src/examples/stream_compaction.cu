#include <cuda_runtime.h>

// Stream compaction: copy the elements a predicate accepts, in order, into a dense
// output array, and report how many there were.
//
// The position is computed rather than claimed, in three launches: each block counts
// its own matches, one block scans those counts, and each block writes its survivors
// at its own offset plus its rank. The third kernel reads the input twice, which is
// the price of shared memory here having no atomic add.
//
// The grid is the problem size, since each thread owns one element. 64x1024 is the
// ceiling, not a preference: scanCounts runs as one block of COMPACT_BLOCKS threads,
// a block holds at most 1024, and both ways past it are broken (128 threads zeroes the
// count; striding the loops emits opcodes GCN3 lacks).
//
// The predicate is a mask rather than `% 5`, and the geometry is written out rather
// than read from blockDim/gridDim: both are forced by the runtime, see
// website/README.md.

#define COMPACT_THREADS 64
#define COMPACT_BLOCKS 1024
#define COMPACT_N (COMPACT_THREADS * COMPACT_BLOCKS)
#define COMPACT_STATE (COMPACT_BLOCKS + 1)
// Every sixteenth element survives, so one in sixteen of COMPACT_N.
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

    // Hillis-Steele, block sized to the data so no bounds test.
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

    // Inclusive scan of the block's flags.
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

    // The count, then the two ends. Each figure gets its own call so the output is
    // one value per line, which is what the correctness suite parses.
    printf("elements = %d\n", COMPACT_N);
    printf("count = %d\n", state[COMPACT_BLOCKS]);
    printf("first = %.1f\n", output[0]);
    printf("last = %.1f\n", output[COMPACT_COUNT - 1]);

    cudaFree(deviceInput);
    cudaFree(deviceOutput);
    cudaFree(deviceState);
    return 0;
}
