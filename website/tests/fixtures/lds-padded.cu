// LDS bank behaviour, padded.
//
// One wavefront of 64 lanes reads a 2-D shared tile. Lanes are the fast index, so
// consecutive lanes are TILE_STRIDE floats apart. TILE_STRIDE is what decides the
// bank pattern, and the two fixtures differ only in it.
//
//   lds-conflict  TILE_STRIDE 32 -> 128 bytes, exactly one bank row, so every lane
//                 of a phase lands in the same bank.
//   lds-padded    TILE_STRIDE 34 -> 136 bytes, not a multiple of the 128-byte row, so
//                 the lanes spread across banks.
//
// Padding by a single float is not enough, and that is worth knowing rather than
// hiding: clang turns the depth-8 read loop into ds_read2_b32, so each lane touches
// two adjacent words and consecutive lanes' pairs overlap by one bank. Stride 33
// still reports degree 2. The fix is padding wider than the access, which is why
// matmul-padded.cu pads by K_TILE + 16 and not by one.
//
// Each lane folds its column into a per-lane total, and the totals are written out so
// the run has an answer; the degrees the analyzer reports are the point, not these.
#include <cuda_runtime.h>

#define TILE_STRIDE 34
#define LANES 64
#define DEPTH 8
#define TILE_ROWS 64

extern "C" __global__ void ldsTile(int *workspace) {
    __shared__ float tile[LANES * TILE_STRIDE];
    int *out = workspace + LANES * TILE_ROWS;

    const int lane = threadIdx.x;
    for (int i = lane; i < LANES * TILE_STRIDE; i += LANES) tile[i] = (float)i;
    __syncthreads();

    float sum = 0.0f;
    for (int k = 0; k < DEPTH; ++k) sum += tile[lane * TILE_STRIDE + k];
    __syncthreads();

    out[lane] = sum;
}

int main(void) {
    static int workspace[LANES * TILE_ROWS + LANES];
    static int result[LANES];
    int *deviceWorkspace;

    cudaMalloc(&deviceWorkspace, sizeof(workspace));
    cudaMemset(deviceWorkspace, 0, sizeof(workspace));

    ldsTile<<<1, LANES>>>(deviceWorkspace);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(result, deviceWorkspace + LANES * TILE_ROWS, LANES * sizeof(int), cudaMemcpyDeviceToHost);
    for (int i = 0; i < LANES; ++i) printf("%d\n", result[i]);

    cudaFree(deviceWorkspace);
    return 0;
}
