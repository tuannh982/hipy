# Map: One Thread, One Value

The map pattern is the simplest way to think in parallel: each thread computes exactly one output element from the matching input element. There is no shared state and no synchronization, so it scales linearly with data size. The global thread index when a kernel spans multiple blocks is `blockIdx.x * blockDim.x + threadIdx.x`, where `blockIdx.x` is which block, `blockDim.x` is threads per block, and `threadIdx.x` is the thread within the block. A guard `if (i < n)` prevents threads past the end of the data from writing out of bounds when the launch size does not divide the data size evenly. `__global__` marks a function as a kernel that runs on the device.

## Task
The starter kernel body is empty, so nothing is written and the output stays zero. The launch also uses `1, 16` instead of the computed `blocks, threads`, so it only runs 16 threads even if the data is larger.

## Goal
Compute the global index and set `out[i] = in[i] * in[i]` when `i < n`.

## Your turn
- Fill in the index and guard in the kernel.
- Fix the launch to use `blocks` and `threads`.
- Press Run and read the squares.
- Change the block size and confirm the result is unchanged.
- Change the kernel to add a constant instead of squaring.