#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

export VITE_BASE_PATH="${VITE_BASE_PATH:-/}"
export VITE_DRIVER_ENCODING="${VITE_DRIVER_ENCODING:-brotli}"

project="${CF_PAGES_PROJECT:-hipy}"
branch="${CF_PAGES_BRANCH:-main}"

echo "==> building (base: $VITE_BASE_PATH, driver: $VITE_DRIVER_ENCODING, project: $project)"

npm run prepare-assets --prefix website
npm run build --prefix website

dist=website/dist
if [[ ! -d $dist ]]; then
  echo "error: $dist does not exist after the build" >&2
  exit 1
fi
if [[ -z $(ls -A "$dist") ]]; then
  echo "error: $dist is empty; refusing to publish a blank site" >&2
  exit 1
fi

# The per-file ceiling, checked here rather than discovered as a rejected upload.
# Both large wasm modules are staged pre-compressed for exactly this reason, so a
# build that quietly stopped compressing one would otherwise fail at the far end of
# a long build with a message about a limit rather than about compression.
limit=$((25 * 1024 * 1024))
oversized=$(find "$dist" -type f -size +${limit}c -exec ls -la {} \; || true)
if [[ -n $oversized ]]; then
  echo "error: files over the 25 MiB per-file limit, which Pages rejects:" >&2
  echo "$oversized" >&2
  exit 1
fi

echo "==> publishing $project"
deploy() {
  npx wrangler pages deploy "$dist" \
    --project-name "$project" \
    --branch "$branch" \
    --commit-hash "$(git rev-parse HEAD)" \
    --commit-message "$(git log -1 --format=%s)"
}

if ! output=$(deploy 2>&1); then
  if ! grep -q "8000007" <<<"$output"; then
    echo "$output" >&2
    exit 1
  fi
  echo "==> project $project does not exist yet; creating it (production branch: $branch)"
  npx wrangler pages project create "$project" --production-branch "$branch"
  output=$(deploy 2>&1) || { echo "$output" >&2; exit 1; }
fi
echo "$output"

# Printed from the deploy output rather than composed from the project name.
# pages.dev names are global, not per-account
url=$(grep -oE "https://[a-z0-9.-]+\.pages\.dev" <<<"$output" | tail -1)
cat <<EOF
    Published to Cloudflare Pages project "$project".
$(if [[ -n $url ]]; then echo "    $url"; fi)

    Two things this host does that GitHub Pages did not, and that the site depends on:

      - public/_headers is honoured, so the COOP/COEP pair that earns
        SharedArrayBuffer is actually sent. Without it the Wasmer SDK refuses to
        run, and the compile fails as "device.o: entry not found" -- an error
        about a file clang never had the chance to write.
      - Content-Encoding on the .br assets is honoured, which is what lets the
        driver ship at ~14 MB instead of 72 MB.

    If a learner reports "toolchain asset size mismatch", the edge recompressed an
    asset that was already compressed. The fix is no-transform on that path in
    _headers -- not a looser size check in assetCache.ts, which is what catches a
    truncated 72 MB download.
EOF