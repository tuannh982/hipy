#include <cuda_runtime.h>

// One thread is about to run this body: the launch at the bottom asks for one,
// and the body is still empty.
//
// There is no loop here, and there will not be one. That is the whole idea, and
// it is why the launch configuration at the bottom matters more than anything
// else on this page.

__global__ void fill(float *out) {
  // TODO: write 42.0f into out[threadIdx.x] -- this thread's own cell.
}

// TODO: nothing else is needed in here.

int main(void) {
  const int N = 16;
  static float host[16];
  float *deviceOut;

  cudaMalloc(&deviceOut, N * sizeof(float));
  cudaMemset(deviceOut, 0, N * sizeof(float));

  // TODO: this asks for ONE thread. Change the second number to 16.
  fill<<<1, 1>>>(deviceOut);
  cudaGetLastError();
  cudaDeviceSynchronize();

  cudaMemcpy(host, deviceOut, N * sizeof(float), cudaMemcpyDeviceToHost);
  for (int i = 0; i < N; ++i) printf("out[%2d] = %.1f\n", i, host[i]);

  cudaFree(deviceOut);
  return 0;
}
