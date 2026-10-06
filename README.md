# HIPY

A CUDA playground that compiles `.cu` in the browser and runs the result on a
cycle-accurate AMD GPU simulator.

## What each module does

| Directory | What it does | Outputs |
| --- | --- | --- |
| `toolchain/` | Compiles `.cu` and cross-builds the LLVM driver the browser runs. | `device.co`, `host.o`, `host.wasm`, `llvm-driver.wasm` |
| `simulator/` | Runs a code object on MGPUSim and emits OpenTelemetry metrics. Built to `js/wasm` for the browser. | `sim-runner.wasm`, `wasm_exec.js`, OTLP bodies |
| `website/` | The UI: compiles in a worker, runs the simulator, renders stdout, a metrics dashboard, and a bank-conflict inspector. | `website/dist` |

## Commands

Run from the repository root. Needs GNU Make, `bash`, `tar`, Go 1.27.0, and
Node.js `^20.19.0 || >=22.12.0`.

| Command | Output |
| --- | --- |
| `make deps` | Pinned `simulator/third_party/` checkouts, `node_modules`, the LLVM driver (30–90 min). Idempotent. `SKIP_LLVM=1` reuses an existing driver. Needs SSH access to `github.com:sarchlab`. |
| `make build` | `website/public/sim-runner.wasm`, `wasm_exec.js`, the staged driver and toolchain archive, `website/dist`. Requires `make deps`. |
| `make test` | Toolchain, Go, and website suites. |
| `make smoke` | Compiled Vectoradd artifacts, a run through the wasm exports, and the one-kernel end-to-end test. |
| `make verify` | `gofmt`, `go vet`, `go build` (host and wasm), `tsc`. |
| `make clean` / `make distclean` | Removes build outputs. `distclean` also removes the pinned checkouts and the driver build. |
| `make from-scratch` | `distclean`, `deps`, `build`, `test`, `smoke`. |

Module targets: `make -C toolchain <target>`, `make -C simulator <target>`;
`make help` lists them.

A compile names its target explicitly. `toolchain/toolchains.json` maps a device to
a toolchain (the driver wasm and the device-pass flags) and to an ISA, the
simulator's catalog reports that pair per device, and the browser puts both on the
compile request — so adding an NVIDIA device is a registry row, a simulator
registry entry, and nothing else.

To use the playground: `make deps && make build`, then `cd website && npm run dev`
and press **Run kernel**.

## Reading the output

Kernel names, fixture paths, launch recipes, and expected output live in
`simulator/testdata/fixtures.json`, which the Go tests, both smokes, and the
website tests all read.

v1 supports static `__shared__` memory, fp32, no CUDA libraries, and the GCN3 device.
Simulation timings are not hardware measurements; GCN3 calibration varies
by roughly ±20–30% depending on the kernel.

`.github/workflows/pages.yml` publishes `website/dist`. It needs
`SIM_HARNESS_SSH_KEY` and one manual run with `build_toolchain`, plus
`VITE_BASE_PATH` and `VITE_DRIVER_ENCODING=raw` (see `website/README.md`).