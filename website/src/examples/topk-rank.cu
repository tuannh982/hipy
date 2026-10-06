#include <cuda_runtime.h>

// Top-k by rank, and the simpler of the two selections here.
//
// An element's rank is how many values exceed it, and that number is its position
// in the descending order -- so an element is in the top k exactly when its rank is
// under k. No threshold to search for and no second pass; every element answers for
// itself and only the survivors write.
//
// The cost is that every element pays: n threads each scan all n values, which is
// the wrong shape for a real top-k and the right one to understand first.
// topk-bisect.cu is the version that narrows the problem with a search instead.
//
// The keys are a permutation of 0..255 shuffled by a fixed LCG on the host, so they
// are distinct, the ranks are a permutation, and the output comes out sorted for
// free. Distinctness is also what makes the two examples directly comparable: same
// data, same answer, different algorithm.
#define TOPK_N 256
#define TOPK_THREADS 64
#define TOPK_BLOCKS (TOPK_N / TOPK_THREADS)
#define TOPK_K 8

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
    printf("rank  top[0] = %d, top[7] = %d\n", top[0], top[TOPK_K - 1]);

    cudaFree(deviceInput);
    cudaFree(deviceTop);
    return 0;
}