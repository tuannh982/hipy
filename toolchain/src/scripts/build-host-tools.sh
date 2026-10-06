#!/usr/bin/env bash
# Host build provides llvm-tblgen/clang-tblgen for the cross build.
set -euo pipefail
cd "$(dirname "$0")/../../artifacts"
cmake -G Ninja -S llvm-project/llvm -B build-host \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_ENABLE_PROJECTS=clang \
  -DLLVM_TARGETS_TO_BUILD=host
ninja -C build-host llvm-tblgen clang-tblgen
