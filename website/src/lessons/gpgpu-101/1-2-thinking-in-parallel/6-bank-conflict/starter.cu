#include <cuda_runtime.h>
// Shared memory is split into banks. If two threads in a warp hit the same
// bank, accesses serialize (bank conflict). Padding the array by one avoids it.
__global__ void transpose(float *out, const float *in, int w) {
  __shared__ float tile[16][16]; // TODO: add +1 padding to avoid bank conflict
  int x = threadIdx.x, y = threadIdx.y;
  tile[y][x] = in[y * w + x];
  __syncthreads();
  out[x * w + y] = tile[y][x];
}

int main(void) {
  const int W = 4, H = 4, N = 16;
  static float in[16], host[16];
  for (int i = 0; i < N; ++i) {
    in[i] = (float)i;
  }

  float *dIn, *dOut;
  cudaMalloc(&dIn, N * sizeof(float));
  cudaMalloc(&dOut, N * sizeof(float));
  cudaMemcpy(dIn, in, N * sizeof(float), cudaMemcpyHostToDevice);
  transpose<<<1, dim3(W, H)>>>(dOut, dIn, W);
  cudaGetLastError();
  cudaDeviceSynchronize();
  cudaMemcpy(host, dOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < H; ++i) {
    for (int j = 0; j < W; ++j) {
      printf("%4.0f ", host[i * W + j]);
    }
    printf("\n");
  }
  cudaFree(dIn);
  cudaFree(dOut);
  return 0;
}