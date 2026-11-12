#include <cuda_runtime.h>
#define TILE 32
// Shared memory is split into banks. If two threads of a wavefront hit the same
// bank, accesses serialize (bank conflict). Padding the array by one avoids it.
__global__ void transpose(float *out, const float *in, int w) {
  __shared__ float tile[TILE][TILE + 1]; // +1 padding avoids bank conflict
  int x = threadIdx.x, y = threadIdx.y;
  tile[y][x] = in[y * w + x];
  __syncthreads();
  out[y * w + x] = tile[x][y];
}

int main(void) {
  const int W = TILE, H = TILE, N = TILE * TILE;
  static float in[N], host[N];
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
  for (int i = 0; i < 4; ++i) { // the first four rows of the result
    for (int j = 0; j < W; ++j) {
      printf("out[%3d]=%4.0f\n", i * W + j, host[i * W + j]);
    }
  }
  cudaFree(dIn);
  cudaFree(dOut);
  return 0;
}
