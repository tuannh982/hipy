# No Scatter Allowed

Scatter means a thread writes to a computed output index that may collide with another thread's write. That is a race condition: two threads writing the same cell give an unpredictable result. The fix is to rewrite as a gather: each output cell pulls its inputs and has a single owner, so no race occurs. In a gather, thread i reads from inputs i-1, i, and i+1 and writes only to out[i], which only it owns.

## Task
The starter kernel body is empty. You must gather `in[i]` plus its neighbours into `out[i]`.

## Goal
Gather `in[i]` plus its neighbours into `out[i]`.

## Your turn
- Fill in the gather body.
- Run and read the output.
- Try to express the same computation as a scatter and see why it breaks.