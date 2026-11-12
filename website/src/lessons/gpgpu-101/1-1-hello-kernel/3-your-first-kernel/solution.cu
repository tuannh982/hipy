#include <cuda_runtime.h>

__global__ void fill(float *out) {
  int i = threadIdx.x;
  out[i] = 42.0f;
}

int main(void) {
  const int N = 16;
  static float host[16];
  float *deviceOut;

  cudaMalloc(&deviceOut, N * sizeof(float));
  cudaMemset(deviceOut, 0, N * sizeof(float));

  fill<<<1, 16>>>(deviceOut);
  cudaGetLastError();
  cudaDeviceSynchronize();

  cudaMemcpy(host, deviceOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < N; ++i)
    printf("out[%2d] = %.1f\n", i, host[i]);

  cudaFree(deviceOut);
  return 0;
}
