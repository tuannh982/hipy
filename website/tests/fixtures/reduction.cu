#include <cuda_runtime.h>
#define REDUCE_THREADS 32
#define REDUCE_BLOCKS 8
#define REDUCE_ROUNDS 2
#define REDUCE_N (REDUCE_THREADS * REDUCE_BLOCKS * REDUCE_ROUNDS)

extern "C" __global__ void reduceBlocks(const float *input, float *partials, int n) {
    __shared__ float tile[REDUCE_THREADS];

    // Grid-stride, so a grid smaller than the data is legal: each thread loads
    // REDUCE_ROUNDS elements and the tree below is over threads, not elements.
    float sum = 0.0f;
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < n; i += blockDim.x * gridDim.x) {
        sum += input[i];
    }

    tile[threadIdx.x] = sum;
    __syncthreads();

    // Halve the active width each round. The surviving lanes are the low half, so
    // a round reads a contiguous prefix and the half above it -- the two-stride
    // pattern the LDS bank map draws.
    for (int stride = blockDim.x / 2; stride > 0; stride /= 2) {
        if (threadIdx.x < stride) tile[threadIdx.x] += tile[threadIdx.x + stride];
        __syncthreads();
    }

    if (threadIdx.x == 0) partials[blockIdx.x] = tile[0];
}

// The same reduction at one block, over REDUCE_BLOCKS numbers. That is why the
// first stage's output is a per-block partial rather than an accumulated one.

extern "C" __global__ void reduceFinal(const float *partials, float *total, int count) {
    __shared__ float tile[REDUCE_THREADS];

    float sum = 0.0f;
    for (int i = threadIdx.x; i < count; i += blockDim.x) sum += partials[i];

    tile[threadIdx.x] = sum;
    __syncthreads();

    for (int stride = blockDim.x / 2; stride > 0; stride /= 2) {
        if (threadIdx.x < stride) tile[threadIdx.x] += tile[threadIdx.x + stride];
        __syncthreads();
    }

    if (threadIdx.x == 0) total[0] = tile[0];
}

int main(void) {
    static float input[REDUCE_N];
    static float partials[REDUCE_BLOCKS];
    float total[1];
    float *deviceInput;
    float *devicePartials;
    float *deviceTotal;

    for (int i = 0; i < REDUCE_N; ++i) input[i] = (float)i;

    cudaMalloc(&deviceInput, REDUCE_N * sizeof(float));
    cudaMalloc(&devicePartials, REDUCE_BLOCKS * sizeof(float));
    cudaMalloc(&deviceTotal, sizeof(float));
    cudaMemcpy(deviceInput, input, REDUCE_N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(devicePartials, 0, REDUCE_BLOCKS * sizeof(float));
    cudaMemset(deviceTotal, 0, sizeof(float));

    reduceBlocks<<<REDUCE_BLOCKS, REDUCE_THREADS>>>(deviceInput, devicePartials, REDUCE_N);
    cudaGetLastError();
    cudaDeviceSynchronize();

    reduceFinal<<<1, REDUCE_THREADS>>>(devicePartials, deviceTotal, REDUCE_BLOCKS);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(total, deviceTotal, sizeof(float), cudaMemcpyDeviceToHost);
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    printf("%.1f\n", total[0]);

    cudaFree(deviceInput);
    cudaFree(devicePartials);
    cudaFree(deviceTotal);
    return 0;
}