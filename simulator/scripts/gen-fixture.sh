#!/usr/bin/env bash
# One-time fixture build. Requires Docker. Output is committed; CI does not run this.
#
# Usage: scripts/gen-fixture.sh [SRC] [OUT]
#   SRC  CUDA source inside testdata/   (default: testdata/vectoradd.cpp)
#   OUT  code object written to testdata/ (default: testdata/vectoradd.co)
#   ARCH target ISA to build for        (default: the amdgcn toolchain's defaultArch)
#
# Produces a bare code object ELF, not the default host fatbin: hipcc
# --cuda-device-only emits a clang offload bundle; the device code is unbundled to
# the amdgcn-amd-amdhsa--$arch code object and stored as .co.
#
# The ISA comes from toolchain/toolchains.json rather than being written here, so a
# fixture and a browser compile cannot be built for different parts by accident --
# which is the whole reason the registry exists (see harness/device.go). Pass ARCH
# for a specific one.
# Uses rocm/dev-ubuntu-24.04:7.2.4 — the same image MGPUSim's own benchmark
# fixture Makefiles pin (e.g. amd/benchmarks/polybench/*/native/Makefile).
# Note: --platform linux/amd64 is required on Apple Silicon Macs, matching
# the MGPUSim Makefiles' DOCKER_RUN invocation.
#
# A .cu fixture is a real CUDA source, and the ROCm image ships no
# cuda_runtime.h, so those compile against ../toolchain/src/shim/include — the
# same shim the browser toolchain compiles the examples against, mounted
# read-only at /shim. Only .cu sources need it; a .cpp fixture builds without.
set -euo pipefail
cd "$(dirname "$0")/.."

src=${1:-testdata/vectoradd.cpp}
out=${2:-testdata/vectoradd.co}
arch=${3:-$(node ../toolchain/src/scripts/toolchain-args.mjs - arch gcn3generic)}

if [[ ! -f "$src" ]]; then
  printf 'gen-fixture: source not found: %s\n' "$src" >&2
  exit 1
fi

shim_dir="$PWD/../toolchain/src/shim/include"
shim_flags=()
mounts=(-v "$PWD":/work)
# Key on the extension, not on the source text: grepping for cuda_runtime.h also
# fires on a mere mention of it, including inside a comment, and would then add
# CUDA flags to a hipcc .cpp build. Nothing needed this before ldsconflict.cu, so
# it is a latent trap rather than a live bug.
if [[ "$src" == *.cu ]]; then
  if [[ ! -f "$shim_dir/cuda_runtime.h" ]]; then
    printf 'gen-fixture: %s needs the CUDA shim, not found at %s\n' "$src" "$shim_dir" >&2
    exit 1
  fi
  shim_flags=(-I /shim/include -include cuda_runtime.h -Xclang -fcuda-is-device)
  mounts+=(-v "$(cd "$shim_dir" && pwd -P)":/shim/include:ro)
fi

docker run --rm --platform linux/amd64 \
  "${mounts[@]}" \
  rocm/dev-ubuntu-24.04:7.2.4 bash -c "
  set -euo pipefail
  hipcc --offload-arch=$arch --cuda-device-only -c /work/$src -o /tmp/bundle.o ${shim_flags[*]-}
  BUNDLER=/opt/rocm/llvm/bin/clang-offload-bundler
  \"\$BUNDLER\" --type=o --unbundle \
    --inputs=/tmp/bundle.o \
    --targets=hipv4-amdgcn-amd-amdhsa--$arch \
    --outputs=/work/$out
"
printf 'Built %s for %s\n' "$out" "$arch"
