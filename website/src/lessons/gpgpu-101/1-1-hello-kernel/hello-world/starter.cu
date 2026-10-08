#include <cuda_runtime.h>

// This file runs entirely on the CPU. It has no kernel, no launch, and no device
// memory -- including <cuda_runtime.h> does not start any of that, it only
// declares what a GPU program would need. The header is here because it is the
// one that brings in the C standard library for both halves of the compile.
//
// That is the shape every program in this track has: a `main` that runs on the
// CPU, and the GPU as something `main` may later ask for. Start where every C
// program starts -- with a main that prints something.

int main(void) {
  // TODO: print the text `hello world` on a line of its own. `printf` takes a
  // format string, and the string literal you want is "hello world" -- put a
  // \n at the end of it, or the next output starts on the same line.
  return 0;
}