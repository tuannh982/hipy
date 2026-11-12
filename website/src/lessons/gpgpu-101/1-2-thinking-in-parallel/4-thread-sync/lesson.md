# Thread Sync

Threads in the same block can share a fast scratchpad called `__shared__` memory, and they can wait for each other with `__syncthreads()`. This lets them cooperate: one thread writes a value, everyone synchronizes, and then another thread reads it safely. `__shared__` memory is much faster than global memory but limited in size and only visible within one block. `__syncthreads()` is a barrier: every thread in the block must reach it before any of them continue, so all writes before it are visible to all threads after it.

The example reverses an array: each thread copies its element into `buf`, synchronizes, then reads from the opposite end. Without `__syncthreads()`, a thread might read `buf` before another thread has written it, producing garbage.

## Task
The starter is missing the synchronization before reading, so a thread might read `buf` before another thread has written it. You must add `__syncthreads()`.

## Goal
Add `__syncthreads()` so all writes are visible before reads.

## Your turn
- Add the sync and run; read the reversed array.
- Remove `__syncthreads()` to see garbage.
- Remember: sync is per-block only, never across blocks.