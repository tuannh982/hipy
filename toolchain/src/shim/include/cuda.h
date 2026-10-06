#ifndef HIPY_CUDA_H
#define HIPY_CUDA_H

#include "vector_types.h"

typedef int CUdevice;
typedef int CUcontext;
typedef CUcontext *CUcontext_t;
typedef int CUstream;
typedef int CUevent;

typedef enum CUresult {
    CUDA_SUCCESS = 0,
    CUDA_ERROR_INVALID_VALUE = 1,
    CUDA_ERROR_OUT_OF_MEMORY = 2
} CUresult;

#endif
