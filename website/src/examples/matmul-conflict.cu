#include <cuda_runtime.h>

// Matrix multiply, tiled and deliberately banked.
//
// Same tiling as matmul-tiled.cu with the padding removed, so the LDS reads come
// out conflicted. TILE_STRIDE is a multiple of 32 floats, which is a multiple of
// the 128-byte bank row: every lane of the wave lands in the same bank, and each
// of the 64 lanes needs its own replay.
//
// The LDS tab reports degree 16 at stride 128 for this kernel, and degree 1 at
// stride 136 for matmul-padded.cu. Sixteen rather than 32 because the read is
// ds_read2_b32, which moves 8 bytes per lane, and a phase is 128 bytes -- so half
// the wave is in flight at once and the degree counts the 16 lanes that share a
// bank within one phase.
//
// The aFrag array is the other thing to notice. It is indexed by a loop
// variable, so it cannot live in registers, and clang then emits S_CSELECT_B64
// to choose the scratch address -- an instruction upstream MGPUSim panics on.
// A dynamically indexed private array is a portability constraint, not just a
// performance one.

#define TILE_STRIDE 32

#define BLOCK_X 32
#define BLOCK_Y 8
#define K_TILE 32

extern "C" __global__ void matmulConflict(const float *a, const float *b, float *c, int width, int height) {
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

    matmulConflict<<<dim3(N / BLOCK_X, N / BLOCK_Y), dim3(BLOCK_X, BLOCK_Y)>>>(deviceA, deviceB, deviceC, N, N);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(c, deviceC, N * N * sizeof(float), cudaMemcpyDeviceToHost);
    printf("c[0] = %.1f, c[16383] = %.1f\n", c[0], c[16383]);

    cudaFree(deviceA); cudaFree(deviceB); cudaFree(deviceC);
    return 0;
}
