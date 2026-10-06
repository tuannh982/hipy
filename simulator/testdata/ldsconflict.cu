#include <cuda_runtime.h>

// One wavefront of 64 threads over a 128-float shared tile, with a deliberate
// 2-way bank conflict on every LDS access.
//
// The conflict: tile[2 * i] puts lane L at byte address 8L, so
// bank = (8L / 4) mod 32 = (2L) mod 32. A ds_write_b32 phase is 32 lanes wide, so
// within lanes 0..31 the 16 even banks each receive two *distinct* addresses: for
// each lane L in 0..15, lane L sits at dword 2L (byte 8L) and lane L+16 at dword
// 2L+32 (byte 8L+128), and both land in bank 2L. That is a 2-way conflict. The
// same holds for lanes 32..63. The stride is the whole point: 8 bytes is 2 banks.
// Only the even half of the 128-float tile is used, which is what makes the stride
// 8 rather than 4.
//
// The kernel is deliberately written so that output[i] == a[i] + b[i].
// TestFixtureHappyCase hard-codes that relationship for every fixture carrying a
// uniformLaunch recipe, so a kernel that reindexed its output through the shared
// tile would fail the existing suite even though its bank behaviour was correct.
// Writing and reading the same even-indexed slots keeps the arithmetic identity
// intact while the access pattern stays conflicted.
//
// There is no write loop. llvm does not forward a shared store to the load across a
// barrier -- it cannot prove no other lane wrote the slot -- so both ds_write_b32 and
// ds_read_b32 stand without one, and a bounded loop would only add the
// s_cbranch_execz that MGPUSim answers by splitting the wavefront.
//
// The launch-geometry indexing is not decoration. A kernel that reads only
// threadIdx.x never consults the work-item or work-group ids, so clang emits no
// implicit COV5 hidden-argument block and the code object declares
// kernarg_segment_size: 28 rather than the 288 every other code object in this
// repository has. The simulator's argument packing is built around that block
// (see packRawArgs in harness.go), so indexing the way vectoradd.cpp and every
// website example index keeps the fixture on the layout the harness expects.
// Here the launch is one work group of 64, so blockIdx.x is 0 and blockDim.x is
// 64 and the index is threadIdx.x either way -- the bank pattern is unaffected.
//
// The index i is unbounded, so the tile and buffer accesses are in range only
// while the manifest recipe stays elements == block[0] == grid[0] == 64 -- one
// work group of one wavefront. TestLDSConflictFixtureIsIndexedInBounds in
// harness/ldsbank_inert_test.go asserts that relationship. Do not add a bounds
// loop here to make the kernel safe on its own: a bounded loop compiles into
// s_cbranch_execz, MGPUSim splits the wavefront on it, and the narrowed exec
// mask destroys the full 32-lane phases whose two-way conflict is the point of
// the fixture.
extern "C" __global__ void ldsConflict(const float *a, const float *b, float *c, int n) {
    __shared__ float tile[128];
    const int i = blockIdx.x * blockDim.x + threadIdx.x;

    tile[2 * i] = a[i] + b[i];
    __syncthreads();

    c[i] = tile[2 * i];
}

int main() {
    const int n = 64;
    const int threads = 64;
    float a[64];
    float b[64];
    float c[64];
    float *deviceA;
    float *deviceB;
    float *deviceC;

    for (int i = 0; i < n; ++i) {
        a[i] = (float)i;
        b[i] = (float)(2 * i + 1);
    }

    cudaMalloc(&deviceA, n * sizeof(float));
    cudaMalloc(&deviceB, n * sizeof(float));
    cudaMalloc(&deviceC, n * sizeof(float));
    cudaMemcpy(deviceA, a, n * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemcpy(deviceB, b, n * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(deviceC, 0, n * sizeof(float));

    ldsConflict<<<1, threads>>>(deviceA, deviceB, deviceC, n);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(c, deviceC, n * sizeof(float), cudaMemcpyDeviceToHost);
    printf("c[0] = %.1f, c[63] = %.1f\n", c[0], c[63]);

    cudaFree(deviceA);
    cudaFree(deviceB);
    cudaFree(deviceC);
    return 0;
}
