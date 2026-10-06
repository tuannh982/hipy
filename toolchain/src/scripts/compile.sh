#!/usr/bin/env bash
# usage: compile.sh <file.cu> <outdir> <arch> [toolchain-id]
#
# <arch> is REQUIRED and there is no environment variable that supplies it. A
# caller that has a device resolves the arch from the registry instead:
#
#   arch=$(toolchain-args.mjs - arch gcn3generic)
#   compile.sh kernel.cu build/kernel gfx803
#
# and the browser takes both the arch and the toolchain off the device the
# catalog reported, so neither is ever a build-time constant.
#
# [toolchain-id] defaults to the registry's single toolchain and is an error
# naming the known set once there is more than one. It selects the driver wasm
# and the device-pass flags from toolchains.json, so a second vendor is a row
# there rather than a fork of this script.
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  printf 'usage: %s <file.cu> <outdir> <arch> [toolchain-id]\n' "$0" >&2
  exit 2
fi

script_dir=$(cd "$(dirname "$0")" && pwd -P)
toolchain_dir=$(cd "$script_dir/../.." && pwd -P)
toolchain_args="$script_dir/toolchain-args.mjs"
input=$1
outdir=$2
target_arch=$3
toolchain=${4:-$(node "$toolchain_args" - id)}

if [[ "$target_arch" == -* || -z "$target_arch" ]]; then
  printf 'compile.sh: <arch> is required and must be a target name, got "%s"\n' "$target_arch" >&2
  exit 2
fi

# Every one of these is a registry lookup that exits non-zero rather than
# answering a default, so a typo in a caller's arch or toolchain id fails here
# instead of emitting a code object for the wrong target.
triple=$(node "$toolchain_args" "$toolchain" triple)
driver_artifact=$(node "$toolchain_args" "$toolchain" driverArtifact)
device_extra_args=$(node "$toolchain_args" "$toolchain" devicePassArgs)

source_dir=$(cd "$(dirname "$input")" && pwd -P)
source="$source_dir/$(basename "$input")"
mkdir -p "$outdir"
outdir=$(cd "$outdir" && pwd -P)
artifacts=(
  "$outdir/device.co"
  "$outdir/host.o"
  "$outdir/host.wasm"
  "$outdir/fp32-tokens.txt"
)
cleanup_failed_compile() {
  status=$?
  if (( status != 0 )); then
    rm -f "${artifacts[@]}"
  fi
  return "$status"
}
trap cleanup_failed_compile EXIT
rm -f "${artifacts[@]}"

if [[ -f "$toolchain_dir/artifacts/$driver_artifact" ]]; then
  driver="$toolchain_dir/artifacts/$driver_artifact"
elif [[ -f "$toolchain_dir/artifacts/llvm-driver.wasm" && "$driver_artifact" == "llvm-driver-stripped.wasm" ]]; then
  driver="$toolchain_dir/artifacts/llvm-driver.wasm"
else
  printf 'missing LLVM driver: %s\n' "$toolchain_dir/artifacts/$driver_artifact" >&2
  exit 1
fi

runner="$script_dir/run-clang-node.mjs"
shim="$toolchain_dir/src/shim/include"
resource="$toolchain_dir/artifacts/build-wasm/lib/clang/19"
sysroot="$toolchain_dir/artifacts/wasix-sysroot"
common=(
  -x hip
  -std=c++17
  -nogpulib
  -nostdinc++
  -resource-dir "$resource"
  -isysroot "$sysroot"
  -isystem "$sysroot/include"
  -I "$shim"
  -include cuda_runtime.h
)

# The triple names the OS and ABI; -target-cpu carries the ISA. So a second gfx
# part is $target_arch alone and nothing else here changes, and anything that
# names the ISA as a literal must build it from $target_arch instead -- the
# unbundle targets strings in tests/scripts/compile-test.mjs and
# website/src/lib/compilePipeline.ts. This script never unbundles (the
# -cc1 -emit-obj below yields a bare ELF), so the coupling is latent, not live.
#
# One flat array rather than a base list plus a spliced-in tail, because bash
# 3.2 expands "${empty[@]}" to a nounset error under `set -u` and a toolchain
# with no extra device flags is a legitimate row. The extra flags arrive
# newline-separated from the registry and are split with globbing off.
device_args=(
  -cc1
  -triple "$triple"
  -target-cpu "$target_arch"
  -O2
  -emit-obj
  -x hip
  -std=c++17
  -nogpulib
  -nostdinc++
  -resource-dir "$resource"
  -isysroot "$sysroot"
  -isystem "$sysroot/include"
  -internal-isystem "$sysroot/include/c++/v1"
  -I "$shim"
  -include cuda_runtime.h
)
if [[ -n "$device_extra_args" ]]; then
  saved_ifs=$IFS
  set -f
  IFS=$'\n'
  # shellcheck disable=SC2206 # deliberate newline split of one registry field
  device_args+=($device_extra_args)
  IFS=$saved_ifs
  set +f
fi
device_args+=("$source" -o "$outdir/device.co")

CLANG_COMMAND=clang++ node "$runner" --wasm "$driver" \
  "${device_args[@]}"

CLANG_COMMAND=clang++ node "$runner" --wasm "$driver" \
  "${common[@]}" \
  --target=wasm32-wasi \
  --offload-host-only \
  -pthread \
  -c "$source" \
  -o "$outdir/host.o"

CLANG_COMMAND=clang++ node "$runner" --wasm "$driver" \
  "${common[@]}" \
  --target=wasm32-wasi \
  --offload-host-only \
  -pthread \
  -Xclang -dump-raw-tokens \
  -fsyntax-only \
  "$source" \
  > "$outdir/fp32-tokens.txt" 2>&1
if ! node "$script_dir/check-fp32.mjs" "$outdir/fp32-tokens.txt" "$source"; then
  rm -f "$outdir/fp32-tokens.txt"
  exit 1
fi
rm -f "$outdir/fp32-tokens.txt"

CLANG_COMMAND=wasm-ld node "$runner" --wasm "$driver" \
  "$outdir/host.o" \
  -o "$outdir/host.wasm" \
  --allow-undefined \
  --no-entry \
  --export=main

[[ -s "$outdir/host.wasm" ]] || { printf 'host.wasm was not produced\n' >&2; exit 1; }
[[ -s "$outdir/device.co" ]] || { printf 'device.co was not produced\n' >&2; exit 1; }
[[ -s "$outdir/host.o" ]] || { printf 'host.o was not produced\n' >&2; exit 1; }
printf 'toolchain: %s\n' "$toolchain"
printf 'arch:      %s\n' "$target_arch"
printf 'device.co: %s\nhost.o: %s\n' "$outdir/device.co" "$outdir/host.o"
printf 'host.wasm: %s (%s bytes)\n' "$outdir/host.wasm" "$(wc -c < "$outdir/host.wasm")"