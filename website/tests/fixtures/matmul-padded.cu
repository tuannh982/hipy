#include <cuda_runtime.h>
#define TILE_STRIDE 9

#define BLOCK_X 8
#define BLOCK_Y 4
#define K_TILE 8

extern "C" __global__ void matmulPadded(const float *a, const float *b, float *c, int width, int height) {
    __shared__ float tileBt[BLOCK_X][TILE_STRIDE];

    const int tx = threadIdx.x;
    const int ty = threadIdx.y;
    const int row = blockIdx.y * BLOCK_Y + ty;
    const int col = blockIdx.x * BLOCK_X + tx;
    float sum = 0.0f;

    for (int tile = 0; tile * K_TILE < width; ++tile) {
        for (int j = 0; j < BLOCK_X; j += BLOCK_Y) {
            const int lc = j + ty;
            const int k = tile * K_TILE + tx;
            const int bc = blockIdx.x * BLOCK_X + lc;
            tileBt[lc][tx] = (k < width && bc < width) ? b[k * width + bc] : 0.0f;
        }

        float aFrag[K_TILE];
        for (int k = 0; k < K_TILE; ++k) {
            const int gk = tile * K_TILE + k;
            aFrag[k] = (row < height && gk < width) ? a[row * width + gk] : 0.0f;
        }
        __syncthreads();

        for (int k = 0; k < K_TILE; ++k) sum += aFrag[k] * tileBt[tx][k];

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

    matmulPadded<<<dim3(N / BLOCK_X, N / BLOCK_Y), dim3(BLOCK_X, BLOCK_Y)>>>(deviceA, deviceB, deviceC, N, N);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(c, deviceC, N * N * sizeof(float), cudaMemcpyDeviceToHost);
    // Every element, because the correctness suite compares all of them against a
    // CPU reference. A sample would pass on a kernel that is wrong in the middle.
    for (int i = 0; i < N * N; ++i) printf("%.1f\n", c[i]);

    cudaFree(deviceA); cudaFree(deviceB); cudaFree(deviceC);
    return 0;
}
