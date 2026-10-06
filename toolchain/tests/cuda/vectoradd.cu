#include <cuda_runtime.h>

extern "C" __global__ void vectorAdd(const float *a, const float *b, float *c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        c[i] = a[i] + b[i];
    }
}

extern "C" __global__ void sharedMemoryKernel(float *data) {
    __shared__ float tile[64];

    int i = threadIdx.y * blockDim.x + threadIdx.x;
    tile[i] = (float)i;
    __syncthreads();
    tile[i] = tile[(i + 1) % 64];
    __syncthreads();
}

int main() {
    const int n = 512;
    float input[n];
    float otherInput[n];
    float *a;
    float *b;
    float *c;
    cudaMalloc(&a, n * sizeof(float));
    cudaMalloc(&b, n * sizeof(float));
    cudaMalloc(&c, n * sizeof(float));
    cudaMemcpy(a, input, n * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemcpy(b, otherInput, n * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(c, 0, n * sizeof(float));
    vectorAdd<<<4, 64>>>(a, b, c, n);
    sharedMemoryKernel<<<dim3(2, 2), dim3(32, 2)>>>(c);
    cudaGetLastError();
    cudaDeviceSynchronize();
    printf("vectoradd\n");
    cudaFree(a);
    cudaFree(b);
    cudaFree(c);
    return 0;
}
