#include <cuda_runtime.h>
#define N 16

#define BLOCK_X 8
#define BLOCK_Y 4

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
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < N * N; ++i) printf("%.1f\n", c[i]);

    cudaFree(deviceA); cudaFree(deviceB); cudaFree(deviceC);
    return 0;
}
