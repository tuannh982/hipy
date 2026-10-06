#!/usr/bin/env bash
# Restore the pinned third_party/ checkouts that go.mod `replace` directives
# require. These directories are gitignored, so this script is the only way to
# rebuild them after a clean.
#
# Usage:
#   scripts/fetch-deps.sh            fetch both checkouts and apply their patches
#   scripts/fetch-deps.sh --purge    delete third_party/{akita,mgpusim}
#
# Every run re-clones at the pinned commit and re-applies the patches, so the
# result never depends on what was already on disk.
#
# Each checkout has its own patches/ directory, applied in filename order:
#
#   third_party/akita_patches/    the js/wasm build tags and the noop
#                                  data-recording implementations.
#   third_party/mgpusim_patches/  001  the amd/ldsbank analyzer and the
#                                     observation-only plumbing that records LDS
#                                     bank conflicts. Reports; no behaviour change.
#                                  002  S_CSELECT_B64 and the V5 kernel descriptor
#                                     offsets.
#                                  003  v_mov_b64, and s_movk_i32's immediate width.
#                                     Both cdna3-only: decodetable.go is one
#                                     architecture-agnostic table, but VOP1 opcode 56
#                                     is v_movrelsd_b32 on gfx9 and v_mov_b64 on
#                                     gfx940+, which is where LLVM gates it.
#                                  004  the device memory a configuration gets, both
#                                     ways: timingconfig.Builder's WithGPUMemSize and
#                                     GPUMemSize, and driver.Builder's WithCPUMemSize,
#                                     which replaces a hardcoded 4 GiB CPU device;
#                                     plus the cache and DRAM size overrides the
#                                     Customize tab reaches the builders through.
#                                     Setters and forwarding; no behaviour change.
#
# third_party/mgpusim is its own module, so `go test ./...` from simulator/ does
# not run the tests the patch carries. The coverage that stands in for them here
# is website/tests/correctness.test.mjs, which checks every example kernel on
# both ISAs against an independent CPU reference.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=pins.env
source ./pins.env

third_party=third_party

die() {
  printf 'fetch-deps: %s\n' "$1" >&2
  exit 1
}

if (( $# > 1 )); then
  die "usage: fetch-deps.sh [--purge]  (got $# arguments)"
fi

if [[ ${1:-} == --purge ]]; then
  printf 'fetch-deps: removing %s/akita and %s/mgpusim\n' "$third_party" "$third_party"
  rm -rf "$third_party/akita" "$third_party/mgpusim"
  printf 'fetch-deps: purged; run scripts/fetch-deps.sh to restore\n'
  exit 0
elif (( $# == 1 )); then
  die "unknown option: $1"
fi

# Staged in a sibling directory so the handover is a same-filesystem rename, and
# nothing existing is destroyed until a complete checkout of $commit is on disk.
clone_stage=
cleanup_clone_stage() {
  if [[ -n "$clone_stage" ]]; then
    rm -rf "$clone_stage"
  fi
  return 0
}
trap cleanup_clone_stage EXIT

clone_at() {
  local repo=$1 commit=$2 dir=$3
  printf 'fetch-deps: cloning %s at %s\n' "$repo" "$commit"
  mkdir -p "$(dirname "$dir")"
  clone_stage=$(mktemp -d "$dir.staging.XXXXXX")
  git -C "$clone_stage" init --quiet
  git -C "$clone_stage" remote add origin "$repo"
  if ! git -C "$clone_stage" fetch --quiet --depth 1 origin "$commit"; then
    die "cannot fetch $commit from $repo (SSH access to github.com:sarchlab required)"
  fi
  git -C "$clone_stage" checkout --quiet --detach FETCH_HEAD
  rm -rf "$dir"
  mv "$clone_stage" "$dir"
  clone_stage=
}

# Every *.patch in a checkout's patches/ directory, in filename order. The numeric
# prefix is what establishes the order, so a new patch is a new number rather than a
# new entry here.
#
# The path must be absolute: `git -C <dir> apply <path>` resolves <path> relative
# to <dir>, not to this script's working directory.
apply_patches() {
  local dir=$1 patch_dir=$2
  shift 2
  local extra=("$@")
  local patch
  local applied=()

  if [[ ! -d "$patch_dir" ]]; then
    die "no patches directory at $patch_dir"
  fi
  for patch in "$patch_dir"/*.patch; do
    [[ -e "$patch" ]] || die "no patches in $patch_dir"
    # akita's 001 carries two zero-context hunks in simulation/simulation.go, which
    # git apply rejects unless told otherwise. The mgpusim patches have none and
    # must NOT pass --unidiff-zero: with it, git applies hunks whose context has
    # drifted.
    git -C "$dir" apply ${extra[@]+"${extra[@]}"} "$patch"
    applied+=("$(basename "$patch")")
  done
  printf 'fetch-deps: %s patched with %s\n' "$dir" "${applied[*]}"
}

clone_at "$AKITA_REPO" "$AKITA_COMMIT" "$third_party/akita"
apply_patches "$third_party/akita" "$PWD/$third_party/akita_patches" --unidiff-zero
printf 'fetch-deps: akita ready at %s\n' "$AKITA_COMMIT"

clone_at "$MGPUSIM_REPO" "$MGPUSIM_COMMIT" "$third_party/mgpusim"
apply_patches "$third_party/mgpusim" "$PWD/$third_party/mgpusim_patches"
printf 'fetch-deps: mgpusim ready at %s\n' "$MGPUSIM_COMMIT"

# Drop stale nested worktree registrations so `git worktree list` reflects
# reality. Its failure is tolerated: prune deletes registrations whose directory
# is merely missing, which is not safely reversible.
git -C "$third_party/akita" worktree prune ||
  printf 'fetch-deps: warning: worktree prune failed; run it by hand\n' >&2