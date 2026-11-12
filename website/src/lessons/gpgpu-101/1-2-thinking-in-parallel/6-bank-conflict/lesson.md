# Bank Conflict

Shared memory is the fast scratchpad inside a GPU. It is much faster than global memory, but it is split into "banks" — 32 of them, each 4 bytes wide, so one bank row is 128 bytes. Address 0 goes to bank 0, address 4 to bank 1, ..., address 124 to bank 31, and address 128 wraps back to bank 0. Two addresses that differ by a multiple of 128 bytes land in the same bank.

A wavefront is a group of 64 threads that run together on this GPU (an NVIDIA warp is 32; this simulator runs the AMD wavefront of 64), and the shared memory unit serves them in phases of 32 lanes. If two lanes of one phase want the same bank at different addresses, they cannot be served at the same time: the hardware serializes them. That is a bank conflict, and it makes the fast memory behave like slow memory. The LDS inspector reports a *degree* for every access: 1 means every bank saw one address, so there is no conflict; 2 means two addresses landed in one bank and had to queue up. Lanes that read the *same* address are a broadcast, not a conflict, so they also report 1.

Why does a transpose cause a conflict? The tile is 32 floats wide, so reading down a column steps 32 floats = 128 bytes = a whole bank row. Every lane of the phase wants the same bank. The inspector reports a degree of 32: a 32-way conflict, the worst there is.

The write `tile[y][x] = in[y * w + x]` is not the problem: consecutive threads write consecutive words, so the 32 lanes of a phase touch 32 different banks. Only the read `tile[x][y]` conflicts.

Padding fixes it: declare `tile[TILE][TILE + 1]` instead of `tile[TILE][TILE]`. The extra column makes every row start one bank further along, so a column no longer walks one bank over and over but walks all of them: relative to the start of the tile, row r now begins at word 33 * r, and (33 * r) mod 32 = r, so lane r lands in bank r. The result is identical; only the speed changes.

## Three scenarios

Scenario A (conflict): `tile[32][32]`, threads read down a column. The addresses are 128 bytes apart, so they all land in the same bank and the accesses serialize. Degree 32.

<video controls width="100%" src="bank-conflict.mp4"></video>

Scenario B (no conflict): `tile[32][33]`, the extra column shifts every row by one bank, so a column read hits 32 different banks and runs in parallel. Degree 1.

<video controls width="100%" src="bank-no-conflict.mp4"></video>

Scenario C (same address): all threads read `tile[0][0]`; the same address is broadcast, no conflict. Degree 1.

<video controls width="100%" src="bank-same-address.mp4"></video>

## Detailed bank conflict explanation

Lanes only collide inside a phase, but that is no comfort: two lanes of one phase that reach the same bank at different addresses serialize, however many lanes the phase holds. For example, thread 0 reading data[0] and thread 2 reading data[32] hit the same bank, because data[32] is 128 bytes further along, so the scheduler must serve them one after the other. Padding shifts the addresses so the lanes hit different banks and run in parallel.

## Task
The starter declares `tile[TILE][TILE]` without padding, so the column read collides. You must add `+1` padding to make it `tile[TILE][TILE + 1]`.

## Goal
Add `+1` padding to `tile[TILE][TILE + 1]`.

## Your turn
- Add the padding and run the transpose; the printed result is unchanged.
- Remove it and watch the LDS inspector report a degree of 32.
- Try `TILE + 2` instead: the column read now lands every other bank, so the degree drops to 2 instead of 1.
- Swap the read to `out[x * w + y] = tile[y][x]`. That reads a row, so it never conflicted — but now the global writes are strided instead of coalesced. You have traded one problem for another.
