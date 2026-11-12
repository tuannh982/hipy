# Gather: Read Anywhere

Gather pattern: one thread reads multiple inputs to compute one output. Unlike map, where one thread reads one input, gather reads a neighbourhood. The output index and the input index no longer match one-to-one, so boundary handling matters. A stencil is a fixed neighbourhood pattern (e.g. left, centre, right). The interior check `i > 0 && i < n - 1` avoids reading out of bounds.

## Task
The starter kernel body is empty, so nothing is written. You must set `out[i] = (in[i-1] + in[i] + in[i+1]) / 3` for interior cells.

## Goal
Set `out[i] = (in[i-1] + in[i] + in[i+1]) / 3` for interior cells.

## Your turn
- Fill in the kernel body.
- Run and read the smoothed values.
- Widen the window to five samples.
- Handle the edges by clamping the index.