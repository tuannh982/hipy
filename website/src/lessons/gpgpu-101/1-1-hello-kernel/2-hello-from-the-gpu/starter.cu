#include <cuda_runtime.h>

// A complete GPU round trip in one file. Nothing is computed yet -- the kernel
// body is empty, so the array keeps the zeros cudaMemset put there. Run it and
// read sixteen zeros out of the Console; the next task is where the threads
// start writing values.

__global__ void fill(float *out) {
  // (empty for now)
}

int main(void) {
  const int N = 16;
  static float host[16];
  float *deviceOut;

  cudaMalloc(&deviceOut, N * sizeof(float));
  cudaMemset(deviceOut, 0, N * sizeof(float));

  // TODO: change the second number to 16.
  fill<<<1, 1>>>(deviceOut);
  cudaGetLastError();
  cudaDeviceSynchronize();

  cudaMemcpy(host, deviceOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < N; ++i)
    printf("out[%2d] = %.1f\n", i, host[i]);

  cudaFree(deviceOut);
  return 0;
}
