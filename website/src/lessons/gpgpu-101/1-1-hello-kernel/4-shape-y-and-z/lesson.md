# Shape: y and z

Threads are not just a line. `threadIdx` is a struct with `.x`, `.y`, and `.z`, and the launch configuration has the same three dimensions. Most of the time you use one dimension and ignore the rest; this task is where the other two earn their keep. `dim3(a, b, c)` is a 3D launch shape. `threadIdx.y` is the row index within the block. The total thread count is the product of all three dimensions. A 2D launch is the natural shape for image data where one thread owns one pixel.

## Task
The starter launches `dim3(1, 1)` and prints a 1x1 grid. You must change it to `dim3(4, 4)` and have each thread write its own `y * 4 + x`.

## Goal
Launch `dim3(4, 4)` and have each thread write its own `y * 4 + x`.

## Your turn
- Change the launch to `dim3(4, 4)`.
- Run and read the 4x4 grid.
- Try `dim3(2, 8)` or `dim3(2, 2, 4)` and watch the shape change.