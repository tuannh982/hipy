#include <cuda_runtime.h>
#define SCAN_TILE 32
#define SCAN_BLOCKS 4
#define SCAN_N (SCAN_TILE * SCAN_BLOCKS)
#define SCAN_TOTALS (2 * SCAN_N)
// One slot past the per-tile totals.
#define SCAN_TOTAL_SLOT SCAN_BLOCKS

extern "C" __global__ void blockScan(float *scan) {
    __shared__ float tile[SCAN_TILE];

    const int tid = threadIdx.x;
    const int index = blockIdx.x * SCAN_TILE + tid;

    const float value = scan[index];
    tile[tid] = value;
    __syncthreads();

    for (int stride = 1; stride < SCAN_TILE; stride *= 2) {
        float running = tile[tid];
        if (tid >= stride) running += tile[tid - stride];
        __syncthreads();
        tile[tid] = running;
        __syncthreads();
    }

    // Inclusive minus this element's own value is the exclusive prefix. The tile's
    // total is the last inclusive prefix; one lane takes it.
    scan[SCAN_N + index] = tile[tid] - value;
    if (tid == SCAN_TILE - 1) scan[SCAN_TOTALS + blockIdx.x] = tile[tid];
}

// Stage two: the same sweep over SCAN_BLOCKS values.
extern "C" __global__ void scanTotals(float *scan) {
    __shared__ float tile[SCAN_BLOCKS];

    const int tid = threadIdx.x;
    tile[tid] = scan[SCAN_TOTALS + tid];
    const float own = tile[tid];
    __syncthreads();

    for (int stride = 1; stride < SCAN_BLOCKS; stride *= 2) {
        float running = tile[tid];
        if (tid >= stride) running += tile[tid - stride];
        __syncthreads();
        tile[tid] = running;
        __syncthreads();
    }

    scan[SCAN_TOTALS + tid] = tile[tid] - own;
    if (tid == SCAN_BLOCKS - 1) scan[SCAN_TOTALS + SCAN_TOTAL_SLOT] = tile[tid];
}

extern "C" __global__ void addOffsets(float *scan) {
    const int index = blockIdx.x * SCAN_TILE + threadIdx.x;
    // No branch on blockIdx: scanTotals already made the first offset 0.
    scan[SCAN_N + index] += scan[SCAN_TOTALS + blockIdx.x];
}

int main(void) {
    // input[i] = i + 1, so the exclusive prefix at i is (i + 1) * i / 2. Checkable
    // by hand, and exact in fp32 at this size.
    static float scan[SCAN_TOTALS + SCAN_BLOCKS + 1];
    float *deviceScan;

    for (int i = 0; i < SCAN_N; ++i) scan[i] = (float)(i + 1);

    cudaMalloc(&deviceScan, (SCAN_TOTALS + SCAN_BLOCKS + 1) * sizeof(float));
    cudaMemcpy(deviceScan, scan, SCAN_TOTALS * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(deviceScan + SCAN_TOTALS, 0, (SCAN_BLOCKS + 1) * sizeof(float));

    blockScan<<<SCAN_BLOCKS, SCAN_TILE>>>(deviceScan);
    cudaGetLastError();
    cudaDeviceSynchronize();

    scanTotals<<<1, SCAN_BLOCKS>>>(deviceScan);
    cudaGetLastError();
    cudaDeviceSynchronize();

    addOffsets<<<SCAN_BLOCKS, SCAN_TILE>>>(deviceScan);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(scan, deviceScan + SCAN_N, SCAN_N * sizeof(float), cudaMemcpyDeviceToHost);
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < SCAN_N; ++i) printf("%.1f\n", scan[i]);

    cudaFree(deviceScan);
    return 0;
}