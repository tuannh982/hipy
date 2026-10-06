#ifndef HIPY_CUDA_RUNTIME_API_H
#define HIPY_CUDA_RUNTIME_API_H

#include <stddef.h>
#include "vector_types.h"

typedef enum cudaError {
    cudaSuccess = 0,
    cudaErrorInvalidValue = 1,
    cudaErrorMemoryAllocation = 2,
    cudaErrorLaunchFailure = 4
} cudaError_t;

typedef enum cudaMemcpyKind {
    cudaMemcpyHostToHost = 0,
    cudaMemcpyHostToDevice = 1,
    cudaMemcpyDeviceToHost = 2,
    cudaMemcpyDeviceToDevice = 3,
    cudaMemcpyDefault = 4
} cudaMemcpyKind;

typedef void *cudaStream_t;
typedef cudaStream_t hipStream_t;

#ifdef __cplusplus
extern "C" {
#endif

cudaError_t cudaMalloc(void **pointer, size_t size);
cudaError_t cudaFree(void *pointer);
cudaError_t cudaMemcpy(void *destination, const void *source,
                       size_t count, cudaMemcpyKind kind);
cudaError_t cudaMemset(void *destination, int value, size_t count);
cudaError_t cudaGetLastError(void);
cudaError_t cudaDeviceSynchronize(void);

#ifdef __cplusplus
cudaError_t __hipPushCallConfiguration(dim3 grid, dim3 block,
                                        size_t shared_memory = 0,
                                        hipStream_t stream = 0);
#else
cudaError_t __hipPushCallConfiguration(dim3 grid, dim3 block,
                                        size_t shared_memory,
                                        hipStream_t stream);
#endif
cudaError_t __hipPopCallConfiguration(dim3 *grid, dim3 *block,
                                       size_t *shared_memory,
                                       hipStream_t *stream);
cudaError_t hipLaunchKernel(const void *function, dim3 grid,
                             dim3 block, void **arguments,
                             size_t shared_memory,
                             hipStream_t stream);

/* Public v1 API; the shim maps this CUDA spelling onto clang 19's emitted hipLaunchKernel ABI. */
cudaError_t cudaLaunchKernel(const void *function, dim3 grid, dim3 block,
                              void **arguments, size_t shared_memory,
                              cudaStream_t stream);

#ifdef __cplusplus
}

template <typename T>
inline cudaError_t cudaMalloc(T **pointer, size_t size) {
    return cudaMalloc(reinterpret_cast<void **>(pointer), size);
}
#endif

#endif
