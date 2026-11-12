# Bank Conflict

Shared memory is the fast scratchpad inside a GPU. It is much faster than global memory, but it is split into "banks" — imagine 32 (or 64) separate doors into the memory. If 32 threads in a warp all knock on different doors at the same time, they all get served at once. But if two or more threads knock on the *same* door, they have to line up: that is a bank conflict, and it makes the fast memory behave like slow memory.

A warp is a group of 32 threads that run together on the GPU. When a warp executes one instruction, all 32 threads do it at the same time. Shared memory is divided into banks by address: address 0 goes to bank 0, address 1 to bank 1, ..., address 31 to bank 31, then address 32 wraps back to bank 0. So two addresses that differ by 32 land in the *same* bank.

Why does a transpose cause a conflict? In a 16x16 tile stored row-major, thread (x, y) reads `tile[y][x]`. When writing the transposed result, threads in a warp often read down a column: `tile[0][0], tile[1][0], tile[2][0]...`. Those addresses are 16 apart, and 16 is a divisor-related stride that lands several of them in the same bank, so they serialize.

Padding fixes it: declare `tile[16][17]` instead of `tile[16][16]`. The extra column shifts every row by one bank, so column reads no longer collide. The result is identical; only the speed changes.

## Three scenarios

Scenario A (conflict): `tile[16][16]`, threads read down a column. Addresses are 16 apart, landing in the same bank, so accesses serialize.

<video controls width="100%" src="bank-conflict.mp4"></video>

Scenario B (no conflict): `tile[16][17]`, the extra column shifts each row by one bank, so column reads hit different banks and run in parallel.

<video controls width="100%" src="bank-no-conflict.mp4"></video>

Scenario C (same address): all threads read `tile[0][0]`; same address is broadcast, no conflict.

<video controls width="100%" src="bank-same-address.mp4"></video>

## Detailed bank conflict explanation

In a warp of 32 threads, if two threads access addresses that map to the same bank, the accesses serialize (bank conflict), even if they are in different "waves". For example, thread 0 reading data[0] and thread 2 reading data[32] both hit bank 0, so the scheduler must serialize them. Padding shifts addresses so threads hit different banks and run in parallel.

## Task
The starter uses `tile[16][16]` without padding, so column reads collide. You must add `+1` padding to `tile[16][17]` to remove the conflict.

## Goal
Add `+1` padding to `tile[16][17]`.

## Your turn
- Add the padding and run the transpose.
- Remove it and note the result is unchanged but hardware would be slower.
- Try a stride of 2 or 4 and see which ones conflict.