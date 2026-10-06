# simulator

MGPUSim harness, the wasm build of it that the playground loads, and the tools that
inspect either.

## Layout

| Path | What it is |
|---|---|
| `harness/` | The Go API the TypeScript side drives, plus the device registry. |
| `wasmexec/` | `//go:wasmexport` surface: the functions `sim-runner.wasm` calls, and `env.pushMetrics`, the one callback it calls back. |
| `internal/ldsanalysis`, `internal/otlpcmp` | Bank-conflict analysis and telemetry comparison. Not importable from `cmd/lds-telemetry`; see its build constraint. |
| `ldswire/` | Wire types for telemetry, kept in a leaf package so both a patched and an unpatched MGPUSim can be linked. |
| `telemetry/` | OTLP wiring for the browser's tracing hooks. |
| `testdata/` | Manifest and `.co` fixtures for `make smoke` and `lds-telemetry`. |
| `third_party/` | Pinned Akita and MGPUSim checkouts. Gitignored; `make deps` restores them. |
| `PIN.md`, `pins.env` | The pinned commits. |

## Binaries

Three, and each earns its place.

### `cmd/sim-runner` — the simulator

`js/wasm` only. This is what `website/public/sim-runner.wasm` is, and it is what the
page instantiates. Every other binary here is a development tool; this one ships.

```bash
make wasm      # build it to website/public/sim-runner.wasm
```

### `cmd/instdump` — decode a code object

Native only. Prints a kernel's instruction stream from a compiled `device.co`:
offset, raw first word, mnemonic, format, opcode, and decoded operands.

```bash
go run ./cmd/instdump /tmp/co-gfx942/device.co topkBisect
```

Reach for it whenever a decode is in question. It uses MGPUSim's own decoder, so
comparing its output against `llvm-mc` or clang's `-S` output is how you settle
whether the emulator and the compiler agree about what an instruction is.

It advances by `Inst.ByteSize` rather than a fixed width, because the code mixes
4-byte and 8-byte instructions. A fixed stride silently desynchronises at the first
short instruction and every offset after it is wrong.

### `cmd/lds-telemetry` — one fixture, raw OTLP

Native only. Runs a single uniform-launch fixture and writes its raw OTLP metrics
to stdout as JSON.

```bash
go run ./cmd/lds-telemetry -fixture ldsconflict
```

It has exactly one caller: `harness/ldsbank_patchab_test.go`, which runs the same
workload from a patched and an unpatched MGPUSim and compares. Go compiles ahead of
time, so the two sides cannot be one binary and this is the half that must build
against both.

Its build constraint is load-bearing rather than incidental: the unpatched tree has
no `amd/ldsbank` package, so nothing in this build may import one. That is why the
analyzer reaches the harness as a `Config.LDSDrain` value and the wire types live in
`ldswire`. The A/B checks `go list -deps ./cmd/lds-telemetry` before running it, so a
regression is a test failure rather than a confusing build error later.

It deliberately does not set `LDSDrain`: with no analyzer linked, the report is
empty, which is the shape a pre-patch simulator produced and what the patched build
has to match.

### `harness/stream.go` — the live gauge stream

One JSON body of to-date counters, several times a second, while a kernel runs.
It is the only Go-to-JavaScript traffic in the simulator.

It is driven from a tracing hook, not a timer, and that is forced rather than
preferred. The whole simulation executes inside one `drain` call, so the worker's
stack is occupied for its entire duration; Go's timers are delivered by a JS
`setTimeout` whose continuation re-enters the Go scheduler, and neither can happen
while the stack is busy. `instCountTracer.EndTask` fires per retired instruction on
the engine goroutine, which is both a reliable heartbeat and the only goroutine
that can sample the counters without racing them.

`MetricsSink` is a package variable so `harness` stays free of `js/wasm` and
still builds natively under `go test`; only `wasmexec/stream.go` names the import.

`harness/kernels.go` keeps what each kernel moved: one entry per distinct kernel name
in launch order, per level. Traffic is attributed on every sample rather than at launch
boundaries, so a kernel's figure rises while it runs and the panel draws a hill over
the window it occupied. Nothing is ever removed from that array, because the panel
addresses an entry by its index.

Two figures in a sample need their definition stated rather than inferred:

- **Device memory** is the host's own allocation ledger, not the allocator's
  occupancy. MGPUSim's launch path also allocates a code object, a kernarg segment
  and a packet per launch and never frees them. The driver's page accounting is
  the truth and is unexported, so the panel labels this one "host allocations".
- **Throughput** divides by `SerialEngine.CurrentTime()`, published as
  `hipy.simulator.sim.time`. `kernel.duration` is the busy time of the driver's launch
  command, which is host-side queue accounting, not the time the simulated hardware
  spent, so it cannot be the denominator for a rate.

### `harness/dashboard.go` — how the stream should be drawn

One JSON body per run, read from the `dashboardSchema` export right after
`loadCodeObject`: the charts, their units, the sample path each line comes from, the
memory-hierarchy rows, and the hit-rate meters.

Which cache levels a device has, how many lanes it has and what the headings say are
all device facts, and a list of them written in the website is a guess about hardware
made in the wrong layer. The schema is read off the **built** platform
(`builtMemLevels`, the registered cache tracers) rather than off the device's name,
so a device that gains a level needs no change on either side of the wire.

A path is a dot-separated string rather than a field name because the hierarchy's
traffic lives in a map keyed by the device's own cache levels, so
`memLevels.L2.readSinceLaunchBytes` cannot be a Go field. The browser walks it, and
a path that resolves to nothing renders as absent — which is the difference between
"this device has no MALL" and "the MALL moved nothing".

## Common commands

Run from `simulator/`.

```bash
make deps       # re-clone third_party at the pinned commits and apply the patches
make wasm       # build sim-runner.wasm
make build      # compile and vet every package, native and js/wasm
make test       # Go tests
make smoke      # drive the wasm exports against every manifest fixture
make regen-patch  # regenerate third_party/{akita,mgpusim}_patches/ from the checkouts
make help       # all targets
```