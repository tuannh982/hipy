# Thin orchestration over src/ (build + compile pipeline) and tests/
# (verification). Every target is a script invocation; no logic lives
# here. Run from this directory: make -C toolchain <target>
#
# Layout:
#   src/scripts/  build + compile pipeline scripts
#   src/patches/  patch applied to the pinned LLVM source
#   src/polyfill/ libc polyfill header + no-op stub sources
#   src/shim/     v1 CUDA/HIP headers the passes compile against
#   tests/scripts/  verification scripts
#   tests/cuda/     .cu fixtures
#   runner/       pinned @wasmer/sdk Node host (used by src/ and tests/)
#   pins/         pinned versions + sha256s
#   artifacts/    build output (gitignored)

SHELL := /bin/bash
.DEFAULT_GOAL := help

SRC_DIR  := src
SCRIPTS  := $(SRC_DIR)/scripts
RUNNER   := runner
TESTS    := tests/scripts
CUDA     := tests/cuda
ARTIFACTS := artifacts
DRIVER    := $(ARTIFACTS)/llvm-driver.wasm
STRIPPED  := $(ARTIFACTS)/llvm-driver-stripped.wasm

# Any .cu under tests/cuda/ compiles the same way: make compile
# SRC=tests/cuda/<name>.cu OUT=build/<name>. Only vectoradd.cu is a positive
# fixture, though; the unsupported-*.cu files there are expected to be
# rejected, so `make test`, not `make compile`, is their target.
SRC   ?= $(CUDA)/vectoradd.cu
OUT   ?= build/vectoradd
CodeObject ?= $(OUT)/device.co
SYMBOL ?=

# Which toolchain to build for and which ISA, both resolved out of
# toolchains.json rather than written here. Neither is an environment variable
# and neither has a literal in this file.
#
#   make compile ARCH=gfx900              a specific ISA on the default toolchain
#   make compile TOOLCHAIN=nvptx ARCH=sm_80  a different toolchain entirely
#   make compile DEVICE=gcn3generic       the ISA that device's registry row names
#
# DEVICE wins over ARCH, because a device is what the browser compiles for.
DEVICE  ?=
TOOLCHAIN ?= $(shell node $(SCRIPTS)/toolchain-args.mjs - id)
ARCH ?= $(shell if [ -n '$(DEVICE)' ]; then \
           node $(SCRIPTS)/toolchain-args.mjs '$(TOOLCHAIN)' arch '$(DEVICE)'; \
         else node $(SCRIPTS)/toolchain-args.mjs '$(TOOLCHAIN)' defaultArch; fi)

.PHONY: help deps fetch host-tools llvm strip driver \
        smoke test compile code-check clean distclean

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- dependencies ------------------------------------------------------------

deps: ## Install the pinned @wasmer/sdk runner
	npm ci --prefix runner

# --- build (see README.md) ---------------------------------------------------

fetch: ## Fetch pinned LLVM source, wasix-sysroot, wasi-sdk (sha256-checked)
	$(SCRIPTS)/fetch-artifacts.sh

host-tools: ## Build host llvm-tblgen/clang-tblgen
	$(SCRIPTS)/build-host-tools.sh

llvm: ## Cross-build the multicall LLVM driver to wasm32-wasi (30-90 min)
	$(SCRIPTS)/build-llvm.sh

strip: ## Strip debug sections -> llvm-driver-stripped.wasm
	$(SCRIPTS)/strip-llvm.sh

driver: $(STRIPPED) ## Ensure a usable (stripped if possible) driver exists

$(STRIPPED): $(DRIVER)
	$(SCRIPTS)/strip-llvm.sh

# --- tests -------------------------------------------------------------------

smoke: ## Driver smoke test: version, full compile, link
	node $(TESTS)/test-clang-node.mjs

test: smoke ## Smoke + compile pipeline + negative compile tests + target arch
	node $(TESTS)/compile-test.mjs
	node $(TESTS)/compile-failure-test.mjs
	node $(TESTS)/compile-target-test.mjs

# --- one-shot compile --------------------------------------------------------

compile: ## Compile SRC (.cu) to OUT/{device.co,host.o,host.wasm} for TOOLCHAIN/ARCH
	$(SCRIPTS)/compile.sh $(SRC) $(OUT) $(ARCH) $(TOOLCHAIN)

code-check: ## Assert AMDGCN ELF 0xe0 + unmangled kernel symbol + .kd descriptor (SYMBOL overrides the manifest lookup)
	@if [[ -n '$(SYMBOL)' ]]; then \
	  $(TESTS)/expected-code-check.sh $(CodeObject) '$(SYMBOL)'; \
	else \
	  $(TESTS)/expected-code-check.sh $(CodeObject); \
	fi

# --- cleaning ----------------------------------------------------------------

clean: ## Remove build outputs (keeps fetched artifacts)
	rm -rf build

distclean: clean ## Also remove fetched sources, build dirs, and the driver
	rm -rf $(ARTIFACTS)
