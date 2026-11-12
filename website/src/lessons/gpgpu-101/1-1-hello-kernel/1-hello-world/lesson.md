# Hello from the CPU

The smallest C program: print a line of text with `printf`. `printf` is the C standard library function that prints formatted text to stdout. A string literal is text between quotes; without quotes `hello` would be a variable name. `\\n` is a newline character (two source chars, one string char). A format specifier like `%d` is used instead of quotes for numbers.

## Task
The starter has an empty `main` and one TODO. Including `<cuda_runtime.h>` only declares what a GPU program would need; it does not start anything. The header is here because it is the one that brings in the C standard library for both halves of the compile.

## Goal
Print `hello world` on a line of its own using `printf`.

## Your turn
- Add `printf("hello world\\n");`.
- Press Run and read `hello world` from the Console.
- Change the text to anything and run again.
- Remove `\\n` and notice lines run together.