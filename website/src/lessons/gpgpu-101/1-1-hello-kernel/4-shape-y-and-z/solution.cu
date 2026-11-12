#include <cuda_runtime.h>

// Threads are not just a line. threadIdx has .x, .y and .z, and the launch
// configuration has matching dimensions. This program puts sixteen threads in
// a 4x4 square and has each one write its own (x, y) into the output.

__global__ void fill(float *out, int width) {
  int x = threadIdx.x;
  int y = threadIdx.y;
  out[y * width + x] = (float)(y * width + x);
}

int main(void) {
  const int W = 4;
  const int H = 4;
  const int N = W * H;
  static float host[16];
  float *deviceOut;

  cudaMalloc(&deviceOut, N * sizeof(float));
  cudaMemset(deviceOut, 0, N * sizeof(float));

  fill<<<1, dim3(W, H)>>>(deviceOut, W);
  cudaGetLastError();
  cudaDeviceSynchronize();

  cudaMemcpy(host, deviceOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int y = 0; y < H; ++y) {
    for (int x = 0; x < W; ++x) {
      printf("%4.0f ", host[y * W + x]);
    }
    printf("\n");
  }

  cudaFree(deviceOut);
  return 0;
}
