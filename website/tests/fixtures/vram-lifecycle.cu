#include <cuda_runtime.h>

// Device memory allocated and freed AFTER the final cudaDeviceSynchronize.
//
// The live stream is driven by retired instructions, so it stops sampling when the
// last kernel finishes. cudaDeviceSynchronize is a drain, and a drain emits the
// final live sample -- which means it, and not the end of main, is where the panel's
// last point comes from. Anything the host does afterwards is therefore invisible
// unless the run is finalized again once main returns.
//
// This fixture puts one cudaMalloc and three cudaFree after the synchronize, so the
// Device-memory meter ends on a different number than it held during the run: the
// three launch buffers are gone and only the late buffer remains.

#define N 32

extern "C" __global__ void fill(float *out, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) out[i] = 1.0f;
}

int main(void) {
    static float a[N * N];
    static float b[N * N];
    static float c[N * N];
    static float d[N * N];
    float *deviceA;
    float *deviceB;
    float *deviceC;
    float *deviceD;

    for (int i = 0; i < N * N; ++i) { a[i] = 1.0f; b[i] = 2.0f; d[i] = 3.0f; }

    cudaMalloc(&deviceA, N * N * sizeof(float));
    cudaMalloc(&deviceB, N * N * sizeof(float));
    cudaMalloc(&deviceC, N * N * sizeof(float));
    cudaMemcpy(deviceA, a, N * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemcpy(deviceB, b, N * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(deviceC, 0, N * N * sizeof(float));

    fill<<<dim3((N * N) / 64), dim3(64)>>>(deviceC, N * N);
    cudaGetLastError();
    // The last sample the program itself causes. Everything below lands after it.
    cudaDeviceSynchronize();

    cudaMemcpy(c, deviceC, N * N * sizeof(float), cudaMemcpyDeviceToHost);
    printf("c[0] = %.1f\n", c[0]);

    cudaMalloc(&deviceD, N * N * sizeof(float));
    cudaMemcpy(deviceD, d, N * N * sizeof(float), cudaMemcpyHostToDevice);

    cudaFree(deviceA); cudaFree(deviceB); cudaFree(deviceC);
    return 0;
}