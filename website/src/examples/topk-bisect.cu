#include <cuda_runtime.h>

// Top-k by bisection: the counterpart to topk-rank.cu, same data and same answer.
//
// Find the k-th largest value first, then place the k elements at or above it.
// count(x >= t) >= k is monotone in t, so the threshold has a single crossing and a
// binary search finds it in 8 probes. Only the survivors then pay topk-rank's
// expensive scan, so it is paid by k elements rather than all of them.
//
// Each probe is a block-wide count: 64 threads count in parallel and a
// shared-memory scan adds them up. One thread alone would be the same answer for a
// third of the work, with 63 lanes idle at every barrier.
//
// Two shapes follow from the runtime rather than preference, and website/README.md
// has both: one pointer, because the host is given no argument count, and one shared
// array, because a 2-address LDS at constant stride is unimplemented.

#define TOPK_N 256
#define TOPK_THREADS 64
#define TOPK_BLOCKS (TOPK_N / TOPK_THREADS)
#define TOPK_K 8
#define TOPK_PROBES 8

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
    printf("bisect  top[0] = %d, top[7] = %d\n", top[0], top[TOPK_K - 1]);

    cudaFree(deviceWorkspace);
    return 0;
}