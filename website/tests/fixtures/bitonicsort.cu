#include <cuda_runtime.h>
#define SORT_THREADS 32
#define SORT_TILE 64

extern "C" __global__ void bitonicSort(const float *input, float *output) {
    __shared__ float tile[SORT_TILE];

    for (int i = threadIdx.x; i < SORT_TILE; i += SORT_THREADS) tile[i] = input[i];
    __syncthreads();

    for (int k = 2; k <= SORT_TILE; k *= 2) {
        for (int j = k / 2; j > 0; j /= 2) {
            for (int i = threadIdx.x; i < SORT_TILE; i += SORT_THREADS) {
                const int l = i ^ j;
                // `l > i` handles each pair once, and so no two lanes touch one slot.
                if (l > i) {
                    const bool ascending = ((i & k) == 0);
                    const float a = tile[i];
                    const float b = tile[l];
                    if ((a > b) == ascending) {
                        tile[i] = b;
                        tile[l] = a;
                    }
                }
            }
            // One barrier per round: within a round each lane owns disjoint pairs.
            __syncthreads();
        }
    }

    for (int i = threadIdx.x; i < SORT_TILE; i += SORT_THREADS) output[i] = tile[i];
}

int main(void) {
    static float input[SORT_TILE];
    static float output[SORT_TILE];
    float *deviceInput;
    float *deviceOutput;

    unsigned int state = 987654321u;
    for (int i = 0; i < SORT_TILE; ++i) input[i] = (float)i;
    for (int i = SORT_TILE - 1; i > 0; --i) {
        state = state * 1103515245u + 12345u;
        const int j = (int)((state >> 16) % (unsigned int)(i + 1));
        const float swap = input[i];
        input[i] = input[j];
        input[j] = swap;
    }

    cudaMalloc(&deviceInput, SORT_TILE * sizeof(float));
    cudaMalloc(&deviceOutput, SORT_TILE * sizeof(float));
    cudaMemcpy(deviceInput, input, SORT_TILE * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(deviceOutput, 0, SORT_TILE * sizeof(float));

    bitonicSort<<<1, SORT_THREADS>>>(deviceInput, deviceOutput);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(output, deviceOutput, SORT_TILE * sizeof(float), cudaMemcpyDeviceToHost);

    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < SORT_TILE; ++i) printf("%.1f\n", output[i]);

    cudaFree(deviceInput);
    cudaFree(deviceOutput);
    return 0;
}