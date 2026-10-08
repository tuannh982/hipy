# Welcome to HIPY

If you've ever wanted to try writing a GPU kernel but didn't know where to
start, you're in the right place. HIPY lets you write CUDA in your browser and
watch it actually run — no installs, no drivers, no expensive hardware. Just a
text box and a button.

## What HIPY is for

GPUs are strange. Your CPU runs one thing at a time, quietly and carefully,
while a GPU runs thousands of things at once and hopes they don't step on each
other. That bargain is powerful and confusing at the same time, and most people
meet it through documentation and diagrams before they ever get to run anything.

HIPY is the opposite. You write a kernel, press run, and *see what happens* —
how many cycles it took, how your threads grouped together, where your threads
collided in memory. The theory stops being abstract because you watched it
happen.

Put simply: HIPY is a place to learn how GPUs actually behave, by experimenting
with them instead of reading about them.

## What you get to look at

Running a kernel gives you more than a number. Three things come back, and each
one shows you a different part of what the GPU did.

**Metrics.** Cycle counts, memory traffic, and how your threads grouped into
waves — plotted as charts, so you can change one line, run again, and see what
actually moved. This is the "my kernel got slower" turned into "my kernel got
slower *because* of this".

**A bank conflict analyzer.** The shared-memory inspector names the threads that
hit the same bank at the same time and shows you which ones collided. Shared
memory is where GPU programming quietly stops being straightforward, and this
is the tool that makes it visible instead of mysterious.

**Device customization.** Override the cache and memory sizes of the simulated
device and watch what that does to your kernel. Sometimes more L1 makes it
faster. Sometimes it just moves the bottleneck somewhere less obvious. Both are
worth seeing, and both are hard to explore on real hardware you don't own.

## Who it's for

**If you're completely new to GPU programming**, start with
[Learn](/learn). The guides walk you through writing your first kernel and
explain each piece as you go. Nothing here assumes you know what a thread is.

**If you've written CUDA before and want to see inside it**, go straight to the
[Playground](/playground). You'll get the same compiler you're used to, plus
timing and memory telemetry that a profiler on your own machine would give you,
without the setup.

**If you're curious but not sure**, the Playground is a fine place to poke at.
Every example there runs in one click, and you can change one line and run it
again to see what moves.

## How it works

Everything happens right here in this tab. Nothing is sent to a server.

```mermaid
flowchart LR
  A["1. You write CUDA"] --> B["2. LLVM compiles it"]
  B --> C["3. A GPU simulator runs it"]
  C --> D["Cycles, memory traffic,<br/>shared-memory conflicts"]
```

**You write CUDA.** The Playground has a real editor with syntax highlighting
and warnings as you type. Start from one of the examples — a matrix multiply, a
prefix sum, a histogram — or clear it and start fresh.

**LLVM compiles it.** A genuine LLVM/Clang toolchain, cross-compiled to
WebAssembly so it can run inside a browser, translates your code for an AMD GPU.
It's the same compiler you'd install locally, not a simplified stand-in. If your
kernel uses something the target can't do, HIPY tells you instead of failing
quietly.

**A GPU simulator runs it.** Your compiled kernel executes on a cycle-accurate
model of an AMD GPU, and reports back what it found. This is the part that makes
HIPY different from anywhere else you could try it.

## Where to go next

**[Learn](/learn)** — guided tracks from your first kernel through threads,
blocks, shared memory, and coalescing. The gentlest starting point.

**[Playground](/playground)** — skip the reading, start experimenting.

**[References](/references)** — the projects that inspired HIPY, and what to read
once a playground stops surprising you.

## Two things worth knowing up front

**Only AMD GPUs, for now.** HIPY compiles for and simulates AMD hardware. NVIDIA
support is on the way, but right now a kernel written for NVIDIA's architecture
won't run here. If you have an NVIDIA card and want to know what your code costs
on one, this isn't the tool yet.

**The timings are simulated.** They model a real AMD GPU architecture and land
within roughly 20–30% of physical hardware — good enough to understand *why* one
kernel beats another, not something to quote in a paper.
