#include <cuda_runtime.h>

__global__ void unsupported(double a, double b) {
    double result = a + b;
    result = result * 2.0;
}

int main() {
    return 0;
}
