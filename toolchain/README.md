# toolchain

Compiles a `.cu` file to three artifacts, and cross-builds the LLVM driver the
browser runs.

## Output

| Artifact | What it is |
| --- | --- |
| `device.co` | The AMDGCN code object the simulator executes. |
| `host.o` | The relocatable WASI host object. |
| `host.wasm` | The linked WASI host module whose `main()` calls `cudaMalloc` / `cudaMemcpy` / `kernel<<<>>>` / `printf`. |

`llvm` / `strip` also produce `artifacts/llvm-driver-stripped.wasm`,
`artifacts/build-wasm/lib/clang/19/`, and `artifacts/wasix-sysroot/`.

`boundaries.json` is the table of rejections the shim enforces, read by the
negative suite and by the website's About tab.

`toolchains.json` is the registry of compiler toolchains and the devices each one
serves. It is the join between the driver wasm the browser fetches, the clang
flags the device pass needs, and the simulator's own device registry, and every
caller on both sides reads it rather than a copy: `src/scripts/toolchain-args.mjs`
for the shell, `website/src/lib/toolchains.ts` for the browser.

## Commands

Run from the repository root, or `make -C toolchain <target>`. LLVM and wasi-sdk
are fetched rather than vendored, at the versions in `pins/`.

| Command | Output |
| --- | --- |
| `make -C toolchain deps` | Fetches wasi-sdk and the pinned toolchain inputs. |
| `make -C toolchain host-tools` | Builds the host tools. |
| `make -C toolchain llvm` | Cross-builds the driver. 30–90 min. |
| `make -C toolchain strip` | Strips it to `llvm-driver-stripped.wasm`. |
| `make -C toolchain test` | The three suites below. |
| `make -C toolchain compile SRC=… OUT=…` | One `.cu` to the three artifacts. `OUT` is a directory. `TOOLCHAIN=`, `DEVICE=` and `ARCH=` choose the target; all three default out of `toolchains.json`. |
| `make -C toolchain fixture FIXTURE=…` | Compiles one `testdata/fixtures.json` entry. Needs Docker. |
| `make -C toolchain code-check` | Verifies the code object shape. |
| `make -C toolchain clean` | Removes build outputs. |

`make -C toolchain help` lists every target.

| Test command | What it checks |
| --- | --- |
| `node tests/scripts/compile-test.mjs` | A known-good kernel compiles and produces all three artifacts. |
| `node tests/scripts/compile-failure-test.mjs` | Every rejection in `boundaries.json` is emitted, and a rejected compile leaves no usable artifacts behind. |
| `node tests/scripts/compile-target-test.mjs` | The arch argument is the ISA the driver receives, a value with a space is refused as one argument, an omitted arch is a usage error, and an unknown toolchain id fails by name. |

## Reading the output

`compile.sh` takes the ISA as a required argument and resolves the toolchain from
`toolchains.json`; there is no environment variable and no build-time default.
`make compile` fills both in from the registry, so `make compile DEVICE=gcn3generic`
and the browser compile the same device for the same ISA, and a caller that names
no target gets a usage error rather than a part nobody asked for. On the browser
side the device is the source: the simulator's catalog reports a toolchain id and
an arch per device, and the compile request carries both.

`src/scripts/toolchain-args.mjs` prints one registry field, which is how the
Makefile and `compile.sh` read it. A missing toolchain, a missing field or an
unclaimed device exits non-zero naming the known set.

The CUDA shim (`src/shim/include/`) is header-only. `atomicAdd` is a
`static_assert` macro, so an atomic fails at compile time rather than silently
modelling as something else. Host ABI: `cudaMalloc` returns a device pointer the
host passes back to `cudaMemcpy` and `cudaLaunchKernel`; kernel arguments are a
packed block of pointers, fp32 and 32-bit integers.

The driver runs under WASIX rather than plain WASI because it needs
`fork`/`execve` to run `clang` as a subprocess.