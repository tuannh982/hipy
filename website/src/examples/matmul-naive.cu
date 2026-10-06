#include <cuda_runtime.h>

// Matrix multiply, one thread per output element and nothing else.
//
// The baseline the other three matmul examples improve on. Every thread walks a
// whole row of B, so the cost is O(width) per element and the loads are
// uncoalesced: consecutive threads read consecutive elements of A but stride
// width through B. Both problems are in the tiling that follows.

#define N 128

#define BLOCK_X 32
#define BLOCK_Y 8

extern "C" __global__ void matmulNaive(const float *a, const float *b, float *c, int width, int height) {
    int row = blockIdx.y * blockDim.y + threadIdx.y;
    int col = blockIdx.x * blockDim.x + threadIdx.x;
    if (row < height && col < width) {
        float sum = 0.0f;
        for (int k = 0; k < width; ++k) sum += a[row * width + k] * b[k * width + col];
        c[row * width + col] = sum;
    }
}

int main(void) {
    static float a[N * N];
    static float b[N * N];
    static float c[N * N];
    float *deviceA;
    float *deviceB;
    float *deviceC;

    for (int i = 0; i < N * N; ++i) { a[i] = 1.0f; b[i] = 2.0f; }

    cudaMalloc(&deviceA, N * N * sizeof(float));
    cudaMalloc(&deviceB, N * N * sizeof(float));
    cudaMalloc(&deviceC, N * N * sizeof(float));
    cudaMemcpy(deviceA, a, N * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemcpy(deviceB, b, N * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(deviceC, 0, N * N * sizeof(float));

    matmulNaive<<<dim3(N / BLOCK_X, N / BLOCK_Y), dim3(BLOCK_X, BLOCK_Y)>>>(deviceA, deviceB, deviceC, N, N);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(c, deviceC, N * N * sizeof(float), cudaMemcpyDeviceToHost);
    printf("c[0] = %.1f, c[16383] = %.1f\n", c[0], c[16383]);

    cudaFree(deviceA); cudaFree(deviceB); cudaFree(deviceC);
    return 0;
}
