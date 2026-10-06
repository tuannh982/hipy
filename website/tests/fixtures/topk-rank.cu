#include <cuda_runtime.h>
#define TOPK_N 64
#define TOPK_THREADS 32
#define TOPK_BLOCKS (TOPK_N / TOPK_THREADS)
#define TOPK_K 4

extern "C" __global__ void topkRank(const int *input, int *out, int n, int k) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;

    const int value = input[i];
    int rank = 0;
    for (int j = 0; j < n; ++j) {
        if (input[j] > value || (input[j] == value && j < i)) rank++;
    }
    if (rank < k) out[rank] = value;
}

int main(void) {
    static int input[TOPK_N];
    static int top[TOPK_K];
    int *deviceInput;
    int *deviceTop;

    unsigned int state = 12345u;
    for (int i = 0; i < TOPK_N; ++i) input[i] = i;
    for (int i = TOPK_N - 1; i > 0; --i) {
        state = state * 1103515245u + 12345u;
        const int j = (int)((state >> 16) % (unsigned int)(i + 1));
        const int swap = input[i];
        input[i] = input[j];
        input[j] = swap;
    }

    cudaMalloc(&deviceInput, TOPK_N * sizeof(int));
    cudaMalloc(&deviceTop, TOPK_K * sizeof(int));
    cudaMemcpy(deviceInput, input, TOPK_N * sizeof(int), cudaMemcpyHostToDevice);
    cudaMemset(deviceTop, 0, TOPK_K * sizeof(int));

    topkRank<<<TOPK_BLOCKS, TOPK_THREADS>>>(deviceInput, deviceTop, TOPK_N, TOPK_K);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(top, deviceTop, TOPK_K * sizeof(int), cudaMemcpyDeviceToHost);
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < TOPK_K; ++i) printf("%d\n", top[i]);

    cudaFree(deviceInput);
    cudaFree(deviceTop);
    return 0;
}