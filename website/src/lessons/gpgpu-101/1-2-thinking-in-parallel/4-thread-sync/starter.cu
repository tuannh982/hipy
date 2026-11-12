#include <cuda_runtime.h>
__global__ void reverse(float *out, const float *in, int n) {
  __shared__ float buf[16];
  int i = threadIdx.x;
  buf[i] = in[i];
  // TODO: synchronize here.
  out[i] = buf[n - 1 - i];
}

int main(void) {
  const int N = 16;
  static float in[16], host[16];
  for (int i = 0; i < N; ++i) {
    in[i] = (float)i;
  }

  float *dIn, *dOut;
  cudaMalloc(&dIn, N * sizeof(float));
  cudaMalloc(&dOut, N * sizeof(float));
  cudaMemcpy(dIn, in, N * sizeof(float), cudaMemcpyHostToDevice);
  reverse<<<1, N>>>(dOut, dIn, N);
  cudaGetLastError();
  cudaDeviceSynchronize();
  cudaMemcpy(host, dOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < N; ++i) {
    printf("out[%2d]=%.1f\n", i, host[i]);
  }
  cudaFree(dIn);
  cudaFree(dOut);
  return 0;
}