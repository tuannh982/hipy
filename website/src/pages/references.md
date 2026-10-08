# Who inspired this

HIPY would not exist without these two projects. They are not dependencies —
nothing here is built on their code — but they are the reason the idea seemed
worth building in the first place.

**[HipScript](https://hipscript.lights0123.com/)** is where the idea came from.
It showed that CUDA and HIP can be ported into a browser — by chaining chipStar,
clspv, and Tint down to WebGPU — and that you don't need a local toolchain or a
discrete GPU to have a place to write and run a kernel. That was the proof of
concept HIPY is built on. Where HIPY goes a different direction is what it runs
*on*: rather than your real GPU through WebGPU, HIPY targets a simulator, so you
can see the cycles and not just the wall-clock time.

**[gpu.js](https://gpujs.com/)** is where the teaching came from. Its
documentation is a genuinely good entry point for someone meeting GPU
programming for the first time, because it lets you work with parallel work in
plain JavaScript before any of the toolchain gets involved. HIPY borrows that
onboarding instinct and takes it to the harder version: you write the real
language and compile it with a real compiler, which is more to learn up front but
closer to what the language is actually for.

# Where to read further

Once a playground has stopped being surprising, go to the primary sources.

## For CUDA and NVIDIA hardware

- [CUDA C++ Programming Guide](https://docs.nvidia.com/cuda/cuda-programming-guide/index.html)
  — the reference for the language you write here, from the people who defined it.
  Start here if you want to know what the compiler is allowed to do.
- [CUDA C++ Best Practices Guide](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/)
  — how to write kernels that are not accidentally slow. Short, and the
  highest-value read on this page.

## For AMD GPUs and HIP

- [HIP documentation](https://rocm.docs.amd.com/projects/HIP/en/latest/)
  — AMD's equivalent of CUDA, and the direction this playground points.
- [ROCm documentation](https://rocm.docs.amd.com/) — the wider platform around it.

## For how GPUs actually work

- [NVIDIA technologies and GPU architectures](https://www.nvidia.com/en-us/technologies/)
  — NVIDIA's own write-ups of how its architectures are put together: warps,
  memory hierarchy, and occupancy. Reach for it when you want to know *why* the
  simulator reports what it reports.
- [AMD GPUOpen](https://gpuopen.com/) — talks, papers, and practical ROCm material
  from AMD's own engineers, and the closest thing to a counterpart on the
  architecture HIPY actually simulates.

And when you've read enough that you want numbers you can trust, the honest next
step is to buy a GPU and run your kernels on the real thing. Nothing above
substitutes for hardware. HIPY is the cheapest way to find out which questions
are worth taking there.

# Credits

HIPY is built on [LLVM](https://llvm.org/) and Clang for compilation, and
[MGPUSim](https://github.com/sarchlab/mgpusim) for GPU simulation. This project
adds a shared-memory bank-conflict analyzer to MGPUSim; those patches live in the
repository and remain under MGPUSim's own license.

Full license details for every dependency are in the `NOTICE` file in the
[repository](https://github.com/tuannh982/hipy).
