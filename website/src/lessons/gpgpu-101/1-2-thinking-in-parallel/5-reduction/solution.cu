#include <cuda_runtime.h>
__global__ void reduce(float *out, const float *in, int n) {
  __shared__ float s[16];
  int i = threadIdx.x;
  s[i] = (i < n) ? in[i] : 0.0f;
  __syncthreads();
  for (int stride = 8; stride > 0; stride >>= 1) {
    if (i < stride) {
      s[i] += s[i + stride];
    }
    __syncthreads();
  }
  if (i == 0) {
    out[0] = s[0];
  }
}

int main(void) {
  const int N = 16;
  static float in[16], host[1];
  for (int i = 0; i < N; ++i) {
    in[i] = (float)(i + 1);
  }

  float *dIn, *dOut;
  cudaMalloc(&dIn, N * sizeof(float));
  cudaMalloc(&dOut, sizeof(float));
  cudaMemcpy(dIn, in, N * sizeof(float), cudaMemcpyHostToDevice);
  reduce<<<1, 16>>>(dOut, dIn, N);
  cudaGetLastError();
  cudaDeviceSynchronize();
  cudaMemcpy(host, dOut, sizeof(float), cudaMemcpyDeviceToHost);
  printf("sum = %.1f\n", host[0]);
  cudaFree(dIn);
  cudaFree(dOut);
  return 0;
}