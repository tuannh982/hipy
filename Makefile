# Cross-module orchestration for the HIPY playground. Every target delegates to
# a module Makefile or npm script; no build logic lives here.
#
# Modules:
#   toolchain/      LLVM driver + CUDA/HIP compile pipeline (own Makefile)
#   Simulator MGPUSim harness + OTLP emission (own Makefile)
#   website/        Vite app driving the harness in the browser (npm scripts)
#
# Run `make from-scratch` to prove a hard clean is recoverable. Note that
# distclean removes gitignored build inputs, including the pinned
# simulator/third_party/ checkouts and the 30-90 minute LLVM driver build;
# `make deps` restores them. Set SKIP_LLVM=1 to keep an existing driver.

SHELL := /bin/bash
.DEFAULT_GOAL := help

WEBSITE := website
TOOLCHAIN := toolchain
SIMULATOR := simulator

# Compiled smoke artifacts (host.wasm + device.co) live inside the repo so
# `make clean` and `make smoke` agree on who owns them.
SMOKE_ARTIFACTS := $(TOOLCHAIN)/build/smoke
SMOKE_SRC       := $(WEBSITE)/src/examples/reduction.cu

.PHONY: help deps build test toolchain-test smoke website-test verify clean distclean from-scratch

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- dependencies ------------------------------------------------------------

deps: ## Restore every gitignored build input (pinned checkouts, node_modules, LLVM driver)
	$(MAKE) -C $(SIMULATOR) deps
	$(MAKE) -C $(TOOLCHAIN) deps
	npm ci --prefix $(WEBSITE)
	$(MAKE) -C $(TOOLCHAIN) fetch
ifneq ($(SKIP_LLVM),1)
	$(MAKE) -C $(TOOLCHAIN) host-tools
	$(MAKE) -C $(TOOLCHAIN) llvm
	$(MAKE) -C $(TOOLCHAIN) strip
endif

# --- build and test ----------------------------------------------------------

build: ## Build the wasm harness and the website (requires deps for the toolchain driver)
	npm run prepare-assets --prefix $(WEBSITE)
	npm run build --prefix $(WEBSITE)

test: toolchain-test website-test ## Run the toolchain, Go, and website test suites
	$(MAKE) -C $(SIMULATOR) test
	npm test --prefix $(WEBSITE)

# The only coverage of the compile pipeline, the negative compile tests, and the
# code object shape check. `make -C toolchain test` runs the module's own compile
# suites; compile-smoke drives the pipeline end to end from the website. The
# code object check needs a readable artifact, so compile the toolchain's default
# fixture first and let code-check resolve the kernel symbol from
# simulator/testdata/fixtures.json (the output directory is named after the
# manifest id it looks up).
toolchain-test: ## Run the toolchain compile, negative compile, and code object shape suites
	$(MAKE) -C $(TOOLCHAIN) test
	npm run compile-smoke --prefix $(WEBSITE)
	$(MAKE) -C $(TOOLCHAIN) compile
	$(MAKE) -C $(TOOLCHAIN) code-check

smoke: ## Run the Go and website wasm smokes, and the one-kernel end-to-end test
	$(MAKE) -C $(SIMULATOR) smoke
	$(MAKE) -C $(TOOLCHAIN) compile SRC=$(abspath $(SMOKE_SRC)) OUT=$(abspath $(SMOKE_ARTIFACTS))
	ARTIFACT_DIR=$(abspath $(SMOKE_ARTIFACTS)) npm run smoke --prefix $(WEBSITE)

# The four behavioral suites. Each compiles fixtures through the real toolchain and runs
# them in the real wasm simulator, so they need the LLVM driver and the simulator wasm.
# Kept out of `make test` for that reason: `npm run test:all` runs all four.
website-test: ## Run the toolchain, simulator, correctness and LDS suites
	npm run test:all --prefix $(WEBSITE)

verify: ## Check formatting, vet, build, and types
	@test -z "$$(gofmt -l $(SIMULATOR)/cmd $(SIMULATOR)/harness $(SIMULATOR)/telemetry $(SIMULATOR)/wasmexec)" \
		|| (gofmt -l $(SIMULATOR)/cmd $(SIMULATOR)/harness $(SIMULATOR)/telemetry $(SIMULATOR)/wasmexec; exit 1)
	$(MAKE) -C $(SIMULATOR) build
	npm run typecheck --prefix $(WEBSITE)

# --- cleaning ----------------------------------------------------------------

clean: ## Remove build outputs (keeps fetched artifacts and pinned checkouts)
	$(MAKE) -C $(TOOLCHAIN) clean
	$(MAKE) -C $(SIMULATOR) clean
	rm -rf $(WEBSITE)/dist
	rm -f /tmp/sim-runner.wasm /tmp/wasm_exec.js

# `git clean -xfd` skips nested git repositories, and the two most expensive
# inputs are exactly that: simulator/third_party/{akita,mgpusim} and
# toolchain/artifacts/llvm-project. Delegate to the module distclean targets so
# those are genuinely removed, then let git clean handle node_modules and the
# remaining build output.
distclean: clean ## Also remove every gitignored input: checkouts, node_modules, LLVM artifacts
	$(MAKE) -C $(TOOLCHAIN) distclean
	$(MAKE) -C $(SIMULATOR) distclean
	git clean -xfd

from-scratch: distclean ## Full recovery proof: distclean, deps, build, test, smoke
	$(MAKE) deps
	$(MAKE) build
	$(MAKE) test
	$(MAKE) smoke
