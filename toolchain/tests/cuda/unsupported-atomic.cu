#include <cuda_runtime.h>

extern "C" __global__ void atomicKernel(float *data) {
    atomicAdd(data, 1.0f);
}
