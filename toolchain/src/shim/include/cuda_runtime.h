/**
 * Minimal CUDA v1 shim for clang HIP mode.
 *
 * Supported subset: dim3/uint3, CUDA memory and error APIs, HIP kernel-launch
 * declarations, and the thread/block/grid identifiers. v1 accepts float32 device
 * arithmetic; fp64 is rejected.
 */
#ifndef HIPY_CUDA_RUNTIME_H
#define HIPY_CUDA_RUNTIME_H

/* Marker for the v1 float32-only device contract. */
#ifndef __CUDA_FP32_ONLY__
#define __CUDA_FP32_ONLY__ 1
#endif

#ifndef __global__
#define __global__ __attribute__((global))
#endif
#ifndef __host__
#define __host__ __attribute__((host))
#endif
#ifndef __device__
#define __device__ __attribute__((device))
#endif
#ifndef __shared__
#define __shared__ __attribute__((shared))
#endif

#include "cuda_runtime_api.h"

#ifdef __cplusplus
extern "C" {
#endif
int printf(const char *, ...);
#ifdef __cplusplus
}
#endif

#if defined(__cplusplus)
#define atomicAdd(...) static_assert(false, "atomic operations are not supported by the simulator in v1")
#endif

#if defined(__HIP_DEVICE_COMPILE__) || defined(__CUDA_ARCH__)
__device__ inline void __syncthreads() {
    __builtin_amdgcn_s_barrier();
}
#elif defined(__HIP__)
__device__ void __syncthreads();
#else
void __syncthreads(void);
#endif

struct __hip_dims {
    unsigned int x;
    unsigned int y;
    unsigned int z;
};

#define threadIdx (__hip_dims{__builtin_amdgcn_workitem_id_x(), __builtin_amdgcn_workitem_id_y(), __builtin_amdgcn_workitem_id_z()})
#define blockIdx (__hip_dims{__builtin_amdgcn_workgroup_id_x(), __builtin_amdgcn_workgroup_id_y(), __builtin_amdgcn_workgroup_id_z()})
#define blockDim (__hip_dims{__builtin_amdgcn_workgroup_size_x(), __builtin_amdgcn_workgroup_size_y(), __builtin_amdgcn_workgroup_size_z()})
/* The AAMDQ packet's grid_size_{x,y,z} fields hold total work items, not work
 * groups, so CUDA's block-counting gridDim is that field divided by the
 * workgroup size, as llvm-libc's get_num_blocks_x() does. */
#define gridDim (__hip_dims{__builtin_amdgcn_grid_size_x() / __builtin_amdgcn_workgroup_size_x(), __builtin_amdgcn_grid_size_y() / __builtin_amdgcn_workgroup_size_y(), __builtin_amdgcn_grid_size_z() / __builtin_amdgcn_workgroup_size_z()})

#endif
