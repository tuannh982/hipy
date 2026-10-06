#!/usr/bin/env bash
# Cross-builds LLVM (clang + lld + llvm multicall driver) as wasm32-wasi/WASIX
# using wasmer as the CMAKE_CROSSCOMPILING_EMULATOR. Produces
# toolchain/artifacts/llvm-driver.wasm (multicall: clang/clang++/lld/wasm-ld).
#
# Prereqs (see fetch-artifacts.sh / build-host-tools.sh):
#   toolchain/artifacts/llvm-project   (LLVM 19.1.6 @ pins/llvm-commit.txt, patched)
#   toolchain/artifacts/wasix-sysroot  (flattened sysroot)
#   toolchain/artifacts/build-host/bin/{llvm-tblgen,clang-tblgen}
#   ~/.wasmer/bin/wasmer
set -euo pipefail
cd "$(dirname "$0")/../../../" # repo root
ROOT="$(pwd)"
SYSROOT="$ROOT/toolchain/artifacts/wasix-sysroot"
TOOLS="$ROOT/toolchain/artifacts/build-host/bin"
LLVM="$ROOT/toolchain/artifacts/llvm-project"

# Apply WASIX compatibility patch idempotently (silences c-index-test +
# forces LLVM's atomic checks to pass when cross-compiling to wasm).
if ! grep -q "MSVC OR True" "$LLVM/llvm/cmake/modules/CheckAtomic.cmake" \
   || ! grep -q "#add_clang_subdirectory(c-index-test)" "$LLVM/clang/tools/CMakeLists.txt"; then
  git -C "$ROOT" apply --unidiff-zero --directory="$LLVM" toolchain/src/patches/wasix-compat.patch
fi

# Build the polyfill stub libraries:
#  - libmman-polyfill.a: mprotect/posix_madvise/madvise no-ops (the
#    wasix-sysroot headers declare them but libc.a does not implement them).
#  - libsetjmp-polyfill.a: setjmp/longjmp no-ops (the sysroot's setjmp routes
#    through the WASIX stack_checkpoint syscall, which requires binaryen
#    asyncify exports the driver does not have; without this stub the driver
#    dies with exit 45 as soon as cc1 runs. See setjmp-stubs.c for details).
POLYFILL_DIR="$ROOT/toolchain/src/polyfill"
STUBS="$ROOT/toolchain/artifacts/libmman-polyfill.a"
WASIX_CLANG="$ROOT/toolchain/artifacts/wasi-sdk/bin/clang"
"$WASIX_CLANG" --target=wasm32-wasi --sysroot="$SYSROOT" -c "$POLYFILL_DIR/mman-stubs.c" -o "$ROOT/toolchain/artifacts/mman-stubs.o"
"$ROOT/toolchain/artifacts/wasi-sdk/bin/llvm-ar" rcs "$STUBS" "$ROOT/toolchain/artifacts/mman-stubs.o"
SETJMP_STUBS="$ROOT/toolchain/artifacts/libsetjmp-polyfill.a"
"$WASIX_CLANG" --target=wasm32-wasi --sysroot="$SYSROOT" -c "$POLYFILL_DIR/setjmp-stubs.c" -o "$ROOT/toolchain/artifacts/setjmp-stubs.o"
"$ROOT/toolchain/artifacts/wasi-sdk/bin/llvm-ar" rcs "$SETJMP_STUBS" "$ROOT/toolchain/artifacts/setjmp-stubs.o"

mkdir -p "$ROOT/toolchain/artifacts/build-wasm"

# Build configuration for the WebAssembly and AMDGPU targets only.
cmake -G Ninja -S "$LLVM/llvm" -B "$ROOT/toolchain/artifacts/build-wasm" \
  --toolchain "$ROOT/toolchain/src/scripts/wasix_toolchain.cmake" \
  -DLLVM_HOST_TRIPLE=wasm32-wasi \
  -DLLVM_TABLEGEN="$TOOLS/llvm-tblgen" \
  -DCLANG_TABLEGEN="$TOOLS/clang-tblgen" \
  -DCMAKE_CROSSCOMPILING_EMULATOR="$ROOT/toolchain/src/scripts/wasmer-run.sh" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_TARGETS_TO_BUILD="WebAssembly;AMDGPU" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_BUILD_TOOLS=OFF \
  -DLLVM_BUILD_TESTS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_UTILS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_ENABLE_BINDINGS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_BUILD_DOCS=OFF \
  -DLLVM_ENABLE_OCAMLDOC=OFF \
  -DLLVM_ENABLE_BACKTRACES=OFF \
  -DLLVM_ENABLE_UNWIND_TABLES=OFF \
  -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_LIBPFM=OFF \
  -DLLVM_BUILD_STATIC=ON \
  -DCMAKE_SKIP_RPATH=ON \
  -DCMAKE_SKIP_INSTALL_RPATH=ON \
  -DNO_INSTALL_RPATH=ON \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DLLVM_ENABLE_PIC=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_BUILD_TOOLS=OFF \
  -DLLVM_ENABLE_RUNTIMES="" \
  -DLLVM_ENABLE_LIBCXX=ON \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DLLVM_ENABLE_LTO=OFF \
  -DHAVE_SETRLIMIT=NO \
  -DCLANG_HAVE_RLIMITS=NO \
  -DBUILD_SHARED_LIBS=OFF \
  -DLLVM_BUILD_LLVM_DYLIB=OFF

# Note: -DCMAKE_CROSSCOMPILING_EMULATOR must be a COMMAND, not a directory.
# CMake invokes it as `<emulator> <program ...>` when running emulator-wrapped
# build-time checks; wasmer-run.sh inserts wasmer's `run` subcommand in
# between, i.e. `<emulator> <program>` becomes `wasmer run <program>`.
ninja -C "$ROOT/toolchain/artifacts/build-wasm" bin/llvm tools/clang/lib/Headers/all

cp "$ROOT/toolchain/artifacts/build-wasm/bin/llvm" "$ROOT/toolchain/artifacts/llvm-driver.wasm"
echo "OK: $ROOT/toolchain/artifacts/llvm-driver.wasm"
