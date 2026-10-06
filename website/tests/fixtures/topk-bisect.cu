#include <cuda_runtime.h>
#define TOPK_N 64
#define TOPK_THREADS 32
#define TOPK_BLOCKS (TOPK_N / TOPK_THREADS)
#define TOPK_K 4
#define TOPK_PROBES 6

// Keys, output, host range, search bounds: one allocation, so one pointer reaches
// all of them.
#define TOPK_OUT (TOPK_N)
#define TOPK_RANGE (TOPK_OUT + TOPK_K)
#define TOPK_BOUNDS (TOPK_RANGE + 2)
#define TOPK_WORKSPACE (TOPK_BOUNDS + 4)

extern "C" __global__ void topkBisect(int *workspace) {
    __shared__ int scratch[4 + TOPK_THREADS];

    const int *input = workspace;
    int *out = workspace + TOPK_OUT;
    int *bounds = workspace + TOPK_BOUNDS;
    int *tile = scratch + 4;

    const int tid = threadIdx.x;
    if (tid == 0) {
        bounds[0] = workspace[TOPK_RANGE];
        bounds[2] = workspace[TOPK_RANGE + 1];
    }
    __syncthreads();

    // Invariant: count(x >= bounds[0]) >= k. Rounding the probe up lets a
    // two-wide interval keep closing; once the bounds meet, mid == lo and the
    // leftover probes are inert, so there is no convergence test.
    for (int probe = 0; probe < TOPK_PROBES; ++probe) {
        const int lo = bounds[0];
        const int hi = bounds[2];
        const int mid = lo + (hi - lo + 1) / 2;

        int count = 0;
        for (int j = tid; j < TOPK_N; j += TOPK_THREADS) {
            if (input[j] >= mid) count++;
        }

        // Hillis-Steele over the block's counts.
        tile[tid] = count;
        __syncthreads();
        for (int stride = 1; stride < TOPK_THREADS; stride *= 2) {
            int running = tile[tid];
            if (tid >= stride) running += tile[tid - stride];
            __syncthreads();
            tile[tid] = running;
            __syncthreads();
        }
        if (tid == 0) {
            if (tile[TOPK_THREADS - 1] >= TOPK_K) bounds[0] = mid;
            else bounds[2] = mid - 1;
        }
        __syncthreads();
    }

    const int threshold = bounds[0];
    const int i = blockIdx.x * TOPK_THREADS + tid;
    if (i >= TOPK_N) return;

    const int value = input[i];
    if (value < threshold) return;

    int rank = 0;
    for (int j = 0; j < TOPK_N; ++j) {
        if (input[j] > value || (input[j] == value && j < i)) rank++;
    }
    // The rank is the position, so `out` comes out descending unsorted.
    out[rank] = value;
}

int main(void) {
    static int workspace[TOPK_WORKSPACE];
    static int top[TOPK_K];
    int *deviceWorkspace;

    // Same LCG shuffle as topk-rank.cu, so the two differ only in the algorithm.
    unsigned int state = 12345u;
    for (int i = 0; i < TOPK_N; ++i) workspace[i] = i;
    for (int i = TOPK_N - 1; i > 0; --i) {
        state = state * 1103515245u + 12345u;
        const int j = (int)((state >> 16) % (unsigned int)(i + 1));
        const int swap = workspace[i];
        workspace[i] = workspace[j];
        workspace[j] = swap;
    }

    int minValue = TOPK_N;
    int maxValue = 0;
    for (int i = 0; i < TOPK_N; ++i) {
        if (workspace[i] < minValue) minValue = workspace[i];
        if (workspace[i] > maxValue) maxValue = workspace[i];
    }
    workspace[TOPK_RANGE] = minValue;
    workspace[TOPK_RANGE + 1] = maxValue;

    cudaMalloc(&deviceWorkspace, TOPK_WORKSPACE * sizeof(int));
    cudaMemcpy(deviceWorkspace, workspace, TOPK_WORKSPACE * sizeof(int), cudaMemcpyHostToDevice);
    cudaMemset(deviceWorkspace + TOPK_OUT, 0, TOPK_K * sizeof(int));

    topkBisect<<<TOPK_BLOCKS, TOPK_THREADS>>>(deviceWorkspace);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(top, deviceWorkspace + TOPK_OUT, TOPK_K * sizeof(int), cudaMemcpyDeviceToHost);
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < TOPK_K; ++i) printf("%d\n", top[i]);

    cudaFree(deviceWorkspace);
    return 0;
}