# Reduction

A reduction combines many values into one number: a sum, a min, a max, or a mean. Doing it in one thread takes O(n) time because it loops over every element. Doing it in parallel takes O(log n) time using a tree: pairs of values combine, then pairs of pairs combine, and so on until one value remains.

The shared array `s` holds partial sums. Each thread starts with one input. Then a loop halves the stride each step: thread `i` adds `s[i + stride]` to `s[i]`. After log2(16) = 4 steps, `s[0]` holds the total. `__syncthreads()` after each step ensures every thread has finished writing before the next step reads. Without it, a thread may read a value that has not been written yet.

## Task
The starter is missing synchronization inside the loop, so a step may read values not yet written. You must add `__syncthreads()` after each stride step.

## Goal
Add `__syncthreads()` after each stride step.

## Your turn
- Add the sync and run; check the sum is 136 for inputs 1..16.
- Change the operator to `min` or `max`.
- Reduce a larger array by launching multiple blocks and combining partials.