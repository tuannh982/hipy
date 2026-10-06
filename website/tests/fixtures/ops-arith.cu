// Arithmetic coverage: every scalar operation the other fixtures rely on, one per
// output element, so a regression in any single op is attributed rather than
// showing up as one wrong sum.
//
// Deliberately absent, each because the emulator cannot execute what clang emits
// for it on gfx803:
//
//   integer % and /   clang lowers a remainder into a multiply-high sequence
//                     (VOP3a 257/462). The examples use a mask instead;
//                     stream_compaction.cu says why.
//   float division    VOP3b 480, unimplemented. Found by this fixture: every other
//                     operation here passes, and removing only the divide makes it
//                     pass on both gfx803 and gfx942.
//   sqrt              not implemented either.
//
// A fixture that has to pass cannot carry them, so they are named here instead.
//
// 64-bit arithmetic is here because the examples move pointers around and a learner
// will too, so it is worth knowing it behaves.
#include <cuda_runtime.h>

#define N 64

extern "C" __global__ void opsArith(int *w, float *f) {
    int *out = w + N;
    float *fout = f + N;
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N) return;

    const unsigned int u = (unsigned int)(i * 2654435761u + 12345u);
    const int a = (int)(u >> 8) - 4096; // signed, both signs
    const int b = (i & 7) - 4;
    const long long la = (long long)a * 3;
    const long long lb = (long long)b * 5;

    int r = 0;
    r += a + b;
    r -= a - b;
    r += a * b;
    r ^= a & b;
    r ^= a | b;
    r ^= a ^ b;
    r ^= ~b;
    r ^= (a >> 3);                   // arithmetic shift right
    r ^= (int)((unsigned int)a << 3); // logical shift left
    r ^= (a >> (i & 7));             // variable shift
    r ^= (a < b) ? 1 : 2;
    r ^= (a >= b) ? 4 : 8;
    r ^= (a == b) ? 16 : 32;
    r ^= (int)(la + lb);             // 64-bit add
    r ^= (int)(la * lb);             // 64-bit mul
    r ^= (int)(la >> 2);             // 64-bit shift
    r ^= ((a & 1) == 0) ? 64 : 0;
    r ^= -a;
    r ^= (a >> 31);                  // sign extraction
    out[i] = r;

    const float fa = (float)a * 0.5f;
    const float fb = (float)b * 0.25f;
    float fr = 0.0f;
    fr += fa + fb;
    fr -= fa - fb;
    fr *= fa * fb;
    fr += (fa > fb) ? fa : fb;
    fr += (fa < fb) ? fa : fb;
    fr += (float)(a > b);
    fr += (fa == fb) ? 0.5f : 0.25f;
    fr += -(float)a;
    fout[i] = fr;
}

int main(void) {
    static int w[2 * N];
    static float f[2 * N];
    int *dw;
    float *df;

    cudaMalloc(&dw, 2 * N * sizeof(int));
    cudaMalloc(&df, 2 * N * sizeof(float));
    cudaMemset(dw, 0, 2 * N * sizeof(int));
    cudaMemset(df, 0, 2 * N * sizeof(float));

    opsArith<<<1, N>>>(dw, df);
    cudaGetLastError();
    cudaDeviceSynchronize();

    static int ri[N];
    static float rf[N];
    cudaMemcpy(ri, dw + N, N * sizeof(int), cudaMemcpyDeviceToHost);
    cudaMemcpy(rf, df + N, N * sizeof(float), cudaMemcpyDeviceToHost);
    for (int i = 0; i < N; ++i) printf("%d\n", ri[i]);
    for (int i = 0; i < N; ++i) printf("%.6f\n", rf[i]);

    cudaFree(dw);
    cudaFree(df);
    return 0;
}