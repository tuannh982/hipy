# Thin orchestration over scripts/ and the Go toolchain. Every target is a
# script or toolchain invocation; no build logic lives here. Run from this
# directory: make -C simulator <target>
#
# Layout:
#   harness/     simulator wrapper (harness runtime + OTLP emission)
#   telemetry/   OTLP/JSON serialization boundary
#   wasmexec/    js/wasm exports consumed by the website worker
#   cmd/         build entry points
#   scripts/     fetch-deps.sh, gen-fixture.sh, sim-smoke.mjs
#   testdata/    committed .co fixtures + fixtures.json manifest
#   third_party/ pinned checkouts (gitignored, restored by `make deps`)

SHELL := /bin/bash
.DEFAULT_GOAL := help

SCRIPTS := scripts
WASM_OUT := ../website/public/sim-runner.wasm
WASM_EXEC_OUT := ../website/public/wasm_exec.js

# Fixture paths are declared once, in testdata/fixtures.json. The fixture target
# resolves them from there; SRC/OUT override either one for the one-off case
# (a fixture with no committed source, or a scratch output path). FIXTURE picks
# the manifest entry, defaulting to the first; see ../website/README.md.
FIXTURE ?=
SRC ?=
OUT ?=

.PHONY: help deps build test smoke wasm smoke-wasm fixture clean distclean

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- dependencies ------------------------------------------------------------

deps: ## Restore the pinned third_party/ checkouts required by go.mod
	$(SCRIPTS)/fetch-deps.sh

# Rewrites the mgpusim patch set from whatever the checkout currently holds, one
# patch per concern. LDSBANK_PATCHES is the analyzer, GCN3_PATCHES the gfx803
# fixes, CDNA3_PATCHES the gfx942 decode gap. Each list is deliberately narrow:
# the checkout also carries edits belonging to no committed patch yet, and a
# broader list would silently absorb them. New paths need intent-to-add first or
# git diff reports nothing for them -- hence the ls-files/add -N pair above, which
# only bites when a fresh checkout still has untracked paths, and whose
# --pathspec-from-file must be absolute because `git -C` chdirs before resolving
# it. The lists are derived rather than written out because a hand-maintained one
# is how an earlier recipe came to omit files. Run it twice and confirm the second
# run is a no-op. CDNA3_PATCHES is cdna3-only on purpose: decodetable.go is shared,
# but VOP1 opcode 56 is v_movrelsd_b32 (a DS-relative store) on gfx9 and v_mov_b64
# (a register move) on gfx940+, so the table cannot serve both and a gcn3 handler for
# it would silently mis-execute a store where the table already panics loudly.
# Replacing the shared entry also costs gfx803 nothing: gcn3's runVOP1 has never had
# a case 56, so a v_movrelsd_b32 word panicked there before this patch and panics
# after it. amd/emu/cdna3/sopk.go is here for the same
# reason: gcn3's s_movk_i32 already widens its sign-extended int16 correctly, so
# the defect is cdna3-only and correcting the shared copy would be a no-op at best.
# amd/insts/decodetable_test.go is the assertion that fails if the opcode 56 entry is
# reverted; it cannot live in the cdna3 emulator test, which builds its operands by
# hand and so never sees the widths the table supplies.
# See third_party/mgpusim_patches/003-cdna3-v_mov-b64.patch.
LDSBANK_PATCHES := amd/ldsbank/ldsbank.go amd/ldsbank/recorder.go \
  amd/emu/gcn3/ldsbank_observe.go amd/emu/gcn3/aluds.go \
  amd/timing/wavefront/wavefront.go amd/timing/cu/ldsunit.go
GCN3_PATCHES := amd/emu/gcn3/alusop2.go amd/insts/hsaco.go
CDNA3_PATCHES := amd/insts/decodetable.go amd/insts/decodetable_test.go \
  amd/emu/cdna3/vop1.go amd/emu/cdna3/sopk.go amd/emu/cdna3/opcode_test.go
# The platform builders, for the figures and sizes the harness sets and reports:
# driver device properties, and the timingconfig entry points (GPUMemSize plus the
# cache and DRAM size overrides the Customize tab sends).
#
# The timingconfig builder files are HERE rather than in a patch of their own
# because deviceinfo already owns amd/samples/runner/timingconfig/builder.go, and
# `git diff` is taken against the pinned upstream commit. A second patch covering
# the same file would repeat deviceinfo's hunks verbatim, and the second `git apply`
# in fetch-deps.sh would fail on them. One patch per FILE, not one per concern.
# akita is patched for the js/wasm build tags and for the cache builder's set-count
# guard. AKITA_PATCHES is a separate list because the akita patch is applied with
# --unidiff-zero (it carries zero-context hunks in simulation.go) while the mgpusim
# patches are not.
AKITA_PATCHES := simulation/builder.go simulation/simulation.go \
  datarecording/datareader.go datarecording/datarecorder.go \
  datarecording/noop.go datarecording/noop_js.go \
  monitoring2/monitor.go monitoring2/monitor_js.go \
  daisen2/daisen2.go daisen2/daisen2_js.go \
  mem/cache/writeback/builder.go mem/cache/writethroughcache/builder.go
DEVICEINFO_PATCHES := amd/driver/builder.go \
  amd/samples/runner/timingconfig/builder.go \
  amd/samples/runner/timingconfig/r9nano/builder.go \
  amd/samples/runner/timingconfig/mi300x/builder.go

# The numeric prefixes are the order scripts/fetch-deps.sh applies the patches in.
regen-patch: ## Regenerate third_party/{akita,mgpusim}_patches/
	# Intent-to-add for UNTRACKED files, per checkout. `git diff` omits them
	# entirely, so a patch that carries a whole new file silently loses it.
	@for dir in third_party/mgpusim third_party/akita; do \
		git -C $$dir ls-files --others --exclude-standard > $(CURDIR)/.new-paths; \
		if test -s $(CURDIR)/.new-paths; then \
			git -C $$dir add -N --pathspec-from-file=$(CURDIR)/.new-paths; \
		fi; \
	done
	@rm -f .new-paths
	git -C third_party/mgpusim diff -- $(LDSBANK_PATCHES) > third_party/mgpusim_patches/001-ldsbank-analyzer.patch
	git -C third_party/mgpusim diff -- $(GCN3_PATCHES) > third_party/mgpusim_patches/002-gcn3-s_cselect.patch
	git -C third_party/mgpusim diff -- $(CDNA3_PATCHES) > third_party/mgpusim_patches/003-cdna3-v_mov-b64.patch
	git -C third_party/mgpusim diff -- $(DEVICEINFO_PATCHES) > third_party/mgpusim_patches/004-device-memory-and-cache-sizes.patch
	git -C third_party/akita diff -- $(AKITA_PATCHES) > third_party/akita_patches/001-wasm-build-tags.patch
	@git diff --stat -- third_party/akita_patches third_party/mgpusim_patches

# --- build and test ----------------------------------------------------------

build: ## Compile and vet every package, native and js/wasm
	go build ./...
	go vet ./...
	GOOS=js GOARCH=wasm go build ./...
	GOOS=js GOARCH=wasm go vet ./...

test: ## Run the Go test suite
	go test ./... -count=1

smoke: smoke-wasm ## Drive the wasm exports against every manifest fixture
	node $(SCRIPTS)/sim-smoke.mjs

# install, not cp: the Go toolchain ships wasm_exec.js mode 444, so a second
# `make wasm` into an existing copy fails with "Permission denied" and takes the
# whole target down with it. install unlinks the destination first and writes the
# mode we ask for, so the copy is idempotent and the target exits 0 every time.
# The build itself is unchanged.
wasm: ## Build cmd/sim-runner to website/public/sim-runner.wasm
	GOOS=js GOARCH=wasm go build -o $(WASM_OUT) ./cmd/sim-runner
	install -m 644 "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(WASM_EXEC_OUT)

# The smoke script loads /tmp/sim-runner.wasm and /tmp/wasm_exec.js by default.
# Rebuilding them on every run keeps `make smoke` self-sufficient on a fresh
# clone; the wasm build takes a few seconds. Same 444-source reason as `wasm`
# above for using install rather than cp.
smoke-wasm:
	GOOS=js GOARCH=wasm go build -o /tmp/sim-runner.wasm ./cmd/sim-runner
	install -m 644 "$$(go env GOROOT)/lib/wasm/wasm_exec.js" /tmp/wasm_exec.js

fixture: ## Rebuild a committed .co fixture (Docker; manual); FIXTURE=<id> selects the manifest entry
	@src='$(SRC)'; out='$(OUT)'; \
	if [[ -z "$$src" || -z "$$out" ]]; then \
	  read -r msrc mout < <($(SCRIPTS)/fixture-paths.mjs $(FIXTURE)) || \
	    { printf 'fixture: cannot resolve %s in testdata/fixtures.json\n' '$(or $(FIXTURE),the first entry)' >&2; exit 1; }; \
	  [[ -n "$$src" ]] || src=$$msrc; \
	  [[ -n "$$out" ]] || out=$$mout; \
	fi; \
	$(SCRIPTS)/gen-fixture.sh "$$src" "$$out"

# --- cleaning ----------------------------------------------------------------

clean: ## Remove generated files (keeps the pinned checkouts)
	rm -f harness/*.sqlite3

distclean: clean ## Also remove the pinned third_party/ checkouts
	$(SCRIPTS)/fetch-deps.sh --purge
