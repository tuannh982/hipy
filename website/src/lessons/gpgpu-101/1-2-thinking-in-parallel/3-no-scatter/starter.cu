#include <cuda_runtime.h>
// Scatter is forbidden: two threads writing same cell race.
// Here we do the gather equivalent instead.
__global__ void gatherSum(float *out, const float *in, int n) {
  int i = threadIdx.x + blockIdx.x * blockDim.x;
  if (i < n) {
    // TODO: gather in[i] plus its neighbours into out[i].
  }
}
int main(void) {
  const int N = 16;
  static float in[16], host[16];
  for (int i = 0; i < N; ++i)
    in[i] = (float)i;
  float *dIn, *dOut;
  cudaMalloc(&dIn, N * sizeof(float));
  cudaMalloc(&dOut, N * sizeof(float));
  cudaMemcpy(dIn, in, N * sizeof(float), cudaMemcpyHostToDevice);
  gatherSum<<<1, 16>>>(dOut, dIn, N);
  cudaGetLastError();
  cudaDeviceSynchronize();
  cudaMemcpy(host, dOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < N; ++i)
    printf("out[%2d]=%.1f\n", i, host[i]);
  cudaFree(dIn);
  cudaFree(dOut);
  return 0;
}