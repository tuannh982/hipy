#ifndef HIPY_VECTOR_TYPES_H
#define HIPY_VECTOR_TYPES_H

typedef unsigned int uint;

struct uint3 {
    unsigned int x;
    unsigned int y;
    unsigned int z;
};

typedef struct dim3 dim3;

struct dim3 {
    unsigned int x;
    unsigned int y;
    unsigned int z;

#ifdef __cplusplus
    dim3() : x(1), y(1), z(1) {}
    dim3(unsigned int x_, unsigned int y_ = 1, unsigned int z_ = 1)
        : x(x_), y(y_), z(z_) {}
#endif
};

#endif
