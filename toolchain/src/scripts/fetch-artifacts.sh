#!/usr/bin/env bash
# Fetches pinned build inputs into toolchain/artifacts/:
#  - llvm-project at the commit recorded in toolchain/pins/llvm-commit.txt
#  - wasix-sysroot release tarball (flattened to wasix-sysroot/{include,lib,share})
#    with sha256 verified against toolchain/pins/wasix-sysroot.txt
#  - wasi-sdk 25.0 release tarball (extracted to wasi-sdk/, used for the
#    host-side wasm cross-clang + ld.lld) with sha256 verified against
#    toolchain/pins/wasi-sdk.txt
set -euo pipefail
cd "$(dirname "$0")/../../../"
ROOT="$(pwd)"
ART="$ROOT/toolchain/artifacts"
mkdir -p "$ART"

# --- llvm-project ---
LLVM_SHA="$(cat toolchain/pins/llvm-commit.txt)"
if [ ! -d "$ART/llvm-project/.git" ]; then
  git clone https://github.com/llvm/llvm-project.git "$ART/llvm-project"
fi
git -C "$ART/llvm-project" fetch origin "$LLVM_SHA" || true
git -C "$ART/llvm-project" checkout --detach "$LLVM_SHA"
# Idempotent patch application (same guard as build-llvm.sh).
if ! grep -q "MSVC OR True" "$ART/llvm-project/llvm/cmake/modules/CheckAtomic.cmake" \
   || ! grep -q "#add_clang_subdirectory(c-index-test)" "$ART/llvm-project/clang/tools/CMakeLists.txt"; then
  git -C "$ART/llvm-project" apply "$ROOT/toolchain/src/patches/wasix-compat.patch"
fi

# --- wasix-sysroot ---
PIN_FILE="toolchain/pins/wasix-sysroot.txt"
WASI_URL="$(sed -n 's/^url=//p' "$PIN_FILE")"
WASI_SHA="$(sed -n 's/^sha256=//p' "$PIN_FILE")"
if [ ! -d "$ART/wasix-sysroot/include" ]; then
  curl -fL --retry 3 -o "$ART/sysroot.tar.gz" "$WASI_URL"
  echo "$WASI_SHA  $ART/sysroot.tar.gz" | shasum -a 256 -c -
  mkdir -p "$ART/_sysroot_extract"
  tar -xzf "$ART/sysroot.tar.gz" -C "$ART/_sysroot_extract"
  # Tarball nests: wasix-sysroot/sysroot/{include,lib,share}; flatten one level.
  mv "$ART/_sysroot_extract/wasix-sysroot/sysroot" "$ART/wasix-sysroot"
  rm -rf "$ART/_sysroot_extract"
fi
if [ -f "$ART/sysroot.tar.gz" ]; then
  echo "$WASI_SHA  $ART/sysroot.tar.gz" | shasum -a 256 -c -
fi

# --- wasi-sdk ---
SDK_PIN_FILE="toolchain/pins/wasi-sdk.txt"
SDK_URL="$(sed -n 's/^url=//p' "$SDK_PIN_FILE")"
SDK_SHA="$(sed -n 's/^sha256=//p' "$SDK_PIN_FILE")"
SDK_TAR_ROOT="$(sed -n 's/^tar_root=//p' "$SDK_PIN_FILE")"
if [ ! -d "$ART/wasi-sdk/bin" ]; then
  curl -fL --retry 3 -o "$ART/wasi-sdk.tar.gz" "$SDK_URL"
  echo "$SDK_SHA  $ART/wasi-sdk.tar.gz" | shasum -a 256 -c -
  mkdir -p "$ART/_wasi_sdk_extract"
  tar -xzf "$ART/wasi-sdk.tar.gz" -C "$ART/_wasi_sdk_extract"
  # Tarball nests: <tar_root>/bin|lib|share|VERSION -> move contents to wasi-sdk/.
  mv "$ART/_wasi_sdk_extract/$SDK_TAR_ROOT" "$ART/wasi-sdk"
  rm -rf "$ART/_wasi_sdk_extract"
fi
echo "fetch-artifacts: OK"
