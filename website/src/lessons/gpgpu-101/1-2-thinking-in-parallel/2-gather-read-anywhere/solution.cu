#include <cuda_runtime.h>
__global__ void blur(float *out, const float *in, int n) {
  int i = threadIdx.x + blockIdx.x * blockDim.x;
  if (i > 0 && i < n - 1) {
    out[i] = (in[i - 1] + in[i] + in[i + 1]) / 3.0f;
  }
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
  blur<<<1, 16>>>(dOut, dIn, N);
  cudaGetLastError();
  cudaDeviceSynchronize();
  cudaMemcpy(host, dOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < N; ++i) {
    printf("out[%2d]=%.2f\n", i, host[i]);
  }
  cudaFree(dIn);
  cudaFree(dOut);
  return 0;
}