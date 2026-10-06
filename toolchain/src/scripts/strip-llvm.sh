#!/usr/bin/env bash
# Strips debug (name) sections from llvm-driver.wasm to shrink it for
# distribution. Produces toolchain/artifacts/llvm-driver-stripped.wasm.
#
# Tools, in order of preference:
#   1. wasm-tools strip 1.259.0 (cargo install wasm-tools --version 1.259.0 --locked)
#   2. wasm-opt --strip-debug 133 (brew install binaryen)
#
set -euo pipefail
cd "$(dirname "$0")/../../../"
ROOT="$(pwd)"
ART="$ROOT/toolchain/artifacts"
SRC="$ART/llvm-driver.wasm"
DST="$ART/llvm-driver-stripped.wasm"

if [ ! -f "$SRC" ]; then
  echo "strip-llvm.sh: $SRC not found (run build-llvm.sh first)" >&2
  exit 1
fi

before=$(stat -f%z "$SRC" 2>/dev/null || stat -c%s "$SRC")
WASM_TOOLS_VERSION=1.259.0
WASM_OPT_VERSION=133
tool=
tool_version=

if command -v wasm-tools >/dev/null 2>&1; then
  if wasm_tools_version=$(wasm-tools --version 2>&1); then
    if [[ "$wasm_tools_version" == *"$WASM_TOOLS_VERSION"* ]]; then
      tool=wasm-tools
      tool_version="$wasm_tools_version"
    else
      echo "strip-llvm.sh: wasm-tools found but version is '$wasm_tools_version'; expected $WASM_TOOLS_VERSION." >&2
      exit 1
    fi
  else
    echo "strip-llvm.sh: wasm-tools --version failed: $wasm_tools_version" >&2
    exit 1
  fi
fi

if [[ -z "$tool" ]] && command -v wasm-opt >/dev/null 2>&1; then
  if wasm_opt_version=$(wasm-opt --version 2>&1); then
    if [[ "$wasm_opt_version" == *"$WASM_OPT_VERSION"* ]]; then
      tool=wasm-opt
      tool_version="$wasm_opt_version"
    else
      echo "strip-llvm.sh: wasm-opt found but version is '$wasm_opt_version'; expected $WASM_OPT_VERSION." >&2
      exit 1
    fi
  else
    echo "strip-llvm.sh: wasm-opt --version failed: $wasm_opt_version" >&2
    exit 1
  fi
fi

if [[ -z "$tool" ]]; then
  echo "strip-llvm.sh: neither pinned wasm-tools $WASM_TOOLS_VERSION nor wasm-opt $WASM_OPT_VERSION found." >&2
  echo "Install with 'cargo install wasm-tools --version $WASM_TOOLS_VERSION --locked' or 'brew install binaryen'." >&2
  exit 1
fi

echo "strip-llvm.sh: using $tool ($tool_version)"
if [[ "$tool" == wasm-tools ]]; then
  wasm-tools strip --all "$SRC" -o "$DST"
else
  wasm-opt --strip-debug --disable-compact-imports --all-features "$SRC" -o "$DST"
fi

after=$(stat -f%z "$DST" 2>/dev/null || stat -c%s "$DST")
echo "strip-llvm.sh: $before -> $after bytes ($(( before / 1024 / 1024 ))MB -> $(( after / 1024 / 1024 ))MB)"
echo "strip-llvm.sh: OK $DST"
