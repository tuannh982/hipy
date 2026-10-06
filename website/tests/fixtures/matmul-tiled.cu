#include <cuda_runtime.h>
#define TILE_X 16
#define TILE_Y 4
#define K_TILE 16
#define TILE_B_STRIDE (K_TILE + 4)

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

#define N 16

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
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < N * N; ++i) printf("%.1f\n", c[i]);

    cudaFree(deviceA); cudaFree(deviceB); cudaFree(deviceC);
    return 0;
}
