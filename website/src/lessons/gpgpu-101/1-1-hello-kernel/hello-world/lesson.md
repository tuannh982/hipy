Every program in this track is a C program that happens to also be able to reach a
GPU. That is worth saying first, because it is the part people get backwards: the
CPU is where your program *starts*, and the GPU is something `main` asks for when
it wants work done in parallel.

So we begin with the smallest useful thing a C program can do — print a line of
text — and get the round trip working before any of the parallel machinery is
involved.

## printf takes a format string

`printf` is the C standard library's, and the starter's single `#include` is what
brings it in. That header is named for a GPU runtime and this program does not
touch a GPU — including it declares what a GPU program *would* need and starts
nothing.

```c
printf("hello world\n");
```

The quotes are part of C, not part of the words. A *string literal* is the text
between them; without them `hello` would be a variable name, and the program
would not compile.

The `\n` at the end is a newline — one character that moves the cursor to the
start of the next line. It is two characters in the source (`\` and `n`) and one
character in the string. Every `printf` in a program that prints more than one
thing wants one, or the lines run together:

```c
printf("hello world\n");   // good: the next output starts on its own line
printf("hello world");     // the next output continues this line
```

You can also leave the quotes out entirely for a value. `printf("42\n")` prints
the characters `4` and `2`; it does not print the number forty-two. Numbers get
a format specifier instead — `%d` for integers — and you will meet those in the
next task.

## Where the output goes

Press **Run** and the output does not appear in the editor. It goes to the
**Console** tab, which is the first tab in the pane to the right.

```mermaid
flowchart LR
  A["you press Run"] --> B["the file is compiled"]
  B --> C["main runs on the CPU"]
  C --> D["printf writes a line"]
  D --> E["the Console tab shows it"]
```

Two things follow from that diagram, and both of them will matter later. The
compiler runs *before* `main`, so a mistake anywhere in the file stops the
program before a single line of your code executes. And the output is a *stream*,
printed in the order the `printf` calls execute — not attached to a line of the
editor, which is why reading the Console is how you check what a kernel did.

## Your turn

Your copy has an empty `main` and one `TODO`. Add the `printf` that prints
`hello world` on a line of its own, press **Run**, and read `hello world` out of
the Console.

Change the text to anything you like and run it again — that is the whole loop
for this task, and it is the same loop you will use for every task in this track.
Type it, run it, read what came back.

If the Console stays empty, the compiler said why above it. A missing `\n` will
still print your text, so if you see the words but they run into the next line,
that is the difference.

The next task puts a GPU in this file. It is a shorter edit than this one was.