#!/usr/bin/env bash
set -u

if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf 'usage: %s <codeObject> [symbol]\n' "$0" >&2
  exit 2
fi

codeObject=$1
manifest=$(cd "$(dirname "$0")/../../.." && pwd)/simulator/testdata/fixtures.json

if [[ ! -s "$codeObject" ]]; then
  printf 'FAIL: readable code object (%s)\n' "$codeObject"
  exit 1
fi
printf 'PASS: readable code object\n'

if [[ $# -eq 2 ]]; then
  symbol=$2
else
  anchor=$(basename "$(dirname "$codeObject")")
  if ! symbol=$(node -e '
const fs = require("node:fs");
const [manifest, anchor] = process.argv.slice(1);
let manifestJson;
try {
  manifestJson = JSON.parse(fs.readFileSync(manifest, "utf8"));
} catch (error) {
  process.stderr.write(`cannot read ${manifest}: ${error.message}\n`);
  process.exit(1);
}
// fixtures[] first: the code-check runs over toolchain/tests/cuda sources, which
// the manifest describes there, and only the website examples live in examples[].
const byAnchor = (candidate) => candidate.id === anchor
  || (typeof candidate.file === "string" && candidate.file.replace(/\.cu$/, "") === anchor);
const entry = (manifestJson.fixtures ?? []).find(byAnchor)
  ?? (manifestJson.examples ?? []).find(byAnchor);
if (!entry) {
  process.stderr.write(`no fixtures[] or examples[] entry in ${manifest} has id or file matching "${anchor}"; pass the kernel symbol as the second argument\n`);
  process.exit(1);
}
process.stdout.write(entry.kernel);
' "$manifest" "$anchor"); then
    printf 'FAIL: resolve kernel symbol for %s\n' "$anchor"
    exit 1
  fi
fi

file_output=$(file "$codeObject")
if [[ "$file_output" == *ELF* && "$file_output" == *"arch 0xe0"* ]]; then
  printf 'PASS: AMDGCN ELF architecture 0xe0 (%s)\n' "$file_output"
else
  printf 'FAIL: AMDGCN ELF architecture 0xe0 (%s)\n' "$file_output"
  exit 1
fi

symbols=$(nm -g "$codeObject" 2>&1)
if printf '%s\n' "$symbols" | grep -Eq "[[:space:]]T[[:space:]]+$symbol$"; then
  printf 'PASS: unmangled %s symbol\n' "$symbol"
else
  printf 'FAIL: unmangled %s symbol\n' "$symbol"
  exit 1
fi

if printf '%s\n' "$symbols" | grep -Eq "[[:space:]][^[:space:]]+[[:space:]]+$symbol\.kd$"; then
  printf 'PASS: %s.kd descriptor\n' "$symbol"
else
  printf 'FAIL: %s.kd descriptor\n' "$symbol"
  exit 1
fi
