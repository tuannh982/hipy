#include <cuda_runtime.h>

// Matrix multiply, tiled through shared memory.
//
// Each block loads a K_TILE-deep slab of A and B into shared memory once, then
// walks it K_TILE times. The global traffic drops by the tile depth, and the
// inner loop now reads shared memory instead of global.
//
// TILE_B_STRIDE is K_TILE + 16 rather than K_TILE. That padding is the whole
// difference from matmul-conflict.cu, and it is worth seeing why: without it,
// tileB[k][tx] has consecutive threads 4 bytes apart, so a read is one bank;
// with 16 floats of padding the row is 192 bytes, the stride is no longer a
// multiple of the 128-byte bank row, and lanes spread across banks.
//
// Two shared arrays here, and that is safe -- the hazard is a 2-address LDS at a
// constant stride, not the number of arrays (website/README.md).

#define TILE_X 32
#define TILE_Y 8
#define K_TILE 32
#define TILE_B_STRIDE (K_TILE + 16)

extern "C" __global__ void matmulTiled(const float *a, const float *b, float *c, int width, int height) {
    __shared__ float tileA[TILE_Y][K_TILE];
    __shared__ float tileB[K_TILE][TILE_B_STRIDE];

    const int tx = threadIdx.x;
    const int ty = threadIdx.y;
    const int row = blockIdx.y * TILE_Y + ty;
    const int col = blockIdx.x * TILE_X + tx;
    const int tileCount = (width + K_TILE - 1) / K_TILE;
    float sum = 0.0f;

    for (int tile = 0; tile < tileCount; ++tile) {
        tileA[ty][tx] = (row < height && tile * K_TILE + tx < width)
            ? a[row * width + tile * K_TILE + tx] : 0.0f;
        for (int j = ty; j < K_TILE; j += TILE_Y) {
            const int bk = tile * K_TILE + j;
            const int bc = col;
            tileB[j][tx] = (bk < width && bc < width) ? b[bk * width + bc] : 0.0f;
        }
        __syncthreads();

        for (int k = 0; k < K_TILE; ++k) sum += tileA[ty][k] * tileB[k][tx];

        __syncthreads();
    }

    if (row < height && col < width) c[row * width + col] = sum;
}

#define N 128

int main(void) {
    static float a[N * N];
    static float b[N * N];
    static float c[N * N];
    float *deviceA;
    float *deviceB;
    float *deviceC;

    for (int i = 0; i < N * N; ++i) { a[i] = 1.0f; b[i] = 2.0f; }

    cudaMalloc(&deviceA, N * N * sizeof(float));
    cudaMalloc(&deviceB, N * N * sizeof(float));
    cudaMalloc(&deviceC, N * N * sizeof(float));
    cudaMemcpy(deviceA, a, N * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemcpy(deviceB, b, N * N * sizeof(float), cudaMemcpyHostToDevice);
    cudaMemset(deviceC, 0, N * N * sizeof(float));

    matmulTiled<<<dim3(N / TILE_X, N / TILE_Y), dim3(TILE_X, TILE_Y)>>>(deviceA, deviceB, deviceC, N, N);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(c, deviceC, N * N * sizeof(float), cudaMemcpyDeviceToHost);
    printf("c[0] = %.1f, c[16383] = %.1f\n", c[0], c[16383]);

    cudaFree(deviceA); cudaFree(deviceB); cudaFree(deviceC);
    return 0;
}
