# Your First Kernel

A kernel is an ordinary C function with one twist: you do not run it once. The compiler turns it into device code, and one launch turns that function into a grid of threads — you say how many you want, and they all run the same body at the same time. Each thread knows its own index and picks which cell of the output it is responsible for. `__global__` marks a function as a kernel that runs on the device. `threadIdx.x` is this thread's index within its block. `fill<<<1, 16>>>` means 1 block of 16 threads.

## Task
The starter asks for one thread and the body is empty, so nothing is written and the array stays zero. You must ask for sixteen threads and write `42.0f` to `out[threadIdx.x]`.

## Goal
Ask for sixteen threads and write `42.0f` to `out[threadIdx.x]`.

## Your turn
- Change `fill<<<1, 1>>>` to `fill<<<1, 16>>>`.
- Add `out[threadIdx.x] = 42.0f;` (or use a variable `int i = threadIdx.x; out[i] = 42.0f;`).
- Run and read sixteen `42`s.
- Hover `threadIdx` in the editor to read its docs.