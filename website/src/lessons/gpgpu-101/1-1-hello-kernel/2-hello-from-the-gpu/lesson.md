# Hello from the GPU

A GPU program is still a C program: `main` runs on the CPU, and the CPU is what asks the GPU to do work. This task is the smallest version of that round trip: allocate memory on the device, launch a kernel, wait for it, copy the result back, and print it. `cudaMalloc` reserves bytes on the device and returns a pointer you cannot dereference from the CPU. `cudaMemset` writes a byte value across a device buffer. `fill<<<1, 16>>>` is launch syntax: 1 block, 16 threads, all running `fill`. `cudaGetLastError` reports and clears whatever error the runtime recorded. `cudaDeviceSynchronize` blocks until every queued kernel has finished. `cudaMemcpy(..., cudaMemcpyDeviceToHost)` moves the array back across the bus.

## Task
The starter wires all six calls but the kernel body is empty, so the array keeps the zeros `cudaMemset` put there. The launch uses `1, 1` in the starter; change it to `1, 16`.

## Goal
Run the round trip and observe sixteen zeros, then experiment.

## Your turn
- Press Run and read sixteen zeros.
- Change the launch to `fill<<<1, 8>>>` and watch the output shrink.
- Change `cudaMemset` value and see it echoed back.
- Add `out[threadIdx.x] = 7.0f;` to the kernel.
- Delete `cudaDeviceSynchronize()` and notice the copy can race the kernel.