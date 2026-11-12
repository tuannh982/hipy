#include <cuda_runtime.h>

__global__ void square(float *out, const float *in, int n) {
  int i = threadIdx.x + blockIdx.x * blockDim.x;
  if (i < n)
    out[i] = in[i] * in[i];
}

int main(void) {
  const int N = 16;
  static float in[16], host[16];
  for (int i = 0; i < N; ++i)
    in[i] = (float)(i + 1);
  float *dIn, *dOut;
  cudaMalloc(&dIn, N * sizeof(float));
  cudaMalloc(&dOut, N * sizeof(float));
  cudaMemcpy(dIn, in, N * sizeof(float), cudaMemcpyHostToDevice);
  int threads = 8, blocks = (N + threads - 1) / threads;
  square<<<blocks, threads>>>(dOut, dIn, N);
  cudaGetLastError();
  cudaDeviceSynchronize();
  cudaMemcpy(host, dOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < N; ++i)
    printf("out[%2d] = %.1f\n", i, host[i]);
  cudaFree(dIn);
  cudaFree(dOut);
  return 0;
}
