#!/usr/bin/env bash
# Strips debug (name) sections from llvm-driver.wasm to shrink it for
# distribution. Produces toolchain/artifacts/llvm-driver-stripped.wasm.
#
# Tool: wasm-tools 1.259.0
#   cargo install wasm-tools --version 1.259.0 --locked
#
# wasm-tools is required, not optional, and binaryen's wasm-opt is not a
# substitute: wasm-opt rewrites the import section into the WASI
# compact-imports encoding, which wasmer does not implement. A driver stripped
# with wasm-opt fails to validate, and the playground reports "unable to spawn
# the command: compile error: Validate(\"Unknown validation error\")" the first
# time it tries to run clang. wasm-tools only removes custom sections, so the
# import section keeps the encoding wasmer accepts.
#
# The stripped driver is verified before this script reports success: a driver
# wasmer cannot spawn is worse than no driver, because the build would succeed
# and the failure would surface in the browser instead.
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

WASM_TOOLS="$("$ROOT/toolchain/src/scripts/check-wasm-tools.sh")"
wasm_tools_version=$("$WASM_TOOLS" --version 2>&1)

echo "strip-llvm.sh: using wasm-tools ($wasm_tools_version)"
"$WASM_TOOLS" strip --all "$SRC" -o "$DST"

after=$(stat -f%z "$DST" 2>/dev/null || stat -c%s "$DST")
echo "strip-llvm.sh: $before -> $after bytes ($(( before / 1024 / 1024 ))MB -> $(( after / 1024 / 1024 ))MB)"

# A driver wasmer cannot spawn is worse than no driver: the build succeeds and
# the failure surfaces in the browser as a compile error. So the artifact is
# checked here, where it is produced, rather than by whoever runs the site.
"$ROOT/toolchain/src/scripts/verify-driver.mjs" "$DST"

echo "strip-llvm.sh: OK $DST"
