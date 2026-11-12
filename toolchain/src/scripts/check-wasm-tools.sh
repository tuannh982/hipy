#!/usr/bin/env bash
# Checks that the pinned wasm-tools is installed, and prints its path.
#
#   check-wasm-tools.sh
#
# Exits non-zero, with the command that fixes it, when wasm-tools is missing
# or is a version other than the pinned one. The pin matters: the strip step
# has to leave the driver's import section in the encoding wasmer accepts, and
# only the pinned wasm-tools is known to do that.
set -euo pipefail

WASM_TOOLS_VERSION=1.259.0

# cargo installs into ~/.cargo/bin, which is not on PATH in every shell.
WASM_TOOLS=
for candidate in "$(command -v wasm-tools 2>/dev/null || true)" "$HOME/.cargo/bin/wasm-tools"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    WASM_TOOLS="$candidate"
    break
  fi
done

if [ -z "$WASM_TOOLS" ]; then
  echo "check-wasm-tools.sh: wasm-tools $WASM_TOOLS_VERSION not found." >&2
  echo "Install with 'cargo install wasm-tools --version $WASM_TOOLS_VERSION --locked'." >&2
  exit 1
fi

if ! wasm_tools_version=$("$WASM_TOOLS" --version 2>&1); then
  echo "check-wasm-tools.sh: wasm-tools --version failed: $wasm_tools_version" >&2
  exit 1
fi
if [[ "$wasm_tools_version" != *"$WASM_TOOLS_VERSION"* ]]; then
  echo "check-wasm-tools.sh: wasm-tools found but version is '$wasm_tools_version'; expected $WASM_TOOLS_VERSION." >&2
  echo "Install with 'cargo install wasm-tools --version $WASM_TOOLS_VERSION --locked'." >&2
  exit 1
fi

echo "$WASM_TOOLS"
