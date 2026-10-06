#include <cuda_runtime.h>

// A bitonic sort of 256 keys by one block, entirely in LDS.
//
// The idea: a bitonic merge network. Compare-exchange each key against the key j
// positions away, for j = N/2, N/4, ... 1, once per stage k = 2, 4, ... N. The
// direction of a comparison is decided by bit k of the index, so each stage sorts
// each half in opposite directions and the last stage merges them. There is no
// data-dependent branch and the comparison count never varies -- the same work on
// sorted input as on random input.
//
// One block, and no merge across blocks. That is a real limit: a longer array has
// stages whose compare pairs land in different blocks, and each of those rounds
// must see the previous round's writes across the whole grid, which a block
// barrier cannot do. A real implementation either keeps the array in one block's
// LDS, as here, or launches a kernel per round.

#define SORT_THREADS 64
#define SORT_TILE 256

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

    // The ends catch a round skipped at either boundary; `ordered` catches one
    // skipped in the middle, which two indices cannot see.
    int ordered = 1;
    for (int i = 1; i < SORT_TILE; ++i) {
        if (output[i] < output[i - 1]) ordered = 0;
    }
    printf("sorted[0] = %.1f, sorted[128] = %.1f, sorted[255] = %.1f\n",
           output[0], output[128], output[SORT_TILE - 1]);
    printf("ordered = %d\n", ordered);

    cudaFree(deviceInput);
    cudaFree(deviceOutput);
    return 0;
}