# HIPY website

The UI: compiles CUDA in a browser worker, runs the result on the wasm GPU
simulator, and renders stdout, a metrics dashboard, and a bank-conflict
inspector.

The editor and the output panel are separated by a draggable divider, which also
takes arrow keys (shift for a larger step) and remembers its position in
`localStorage`. Below 1000px the two stack instead and the divider is removed.

## Commands

Run from `website/`. Needs Node.js `^20.19.0 || >=22.12.0` and, from the
repository root, `make deps && make build`.

| Command | Output |
| --- | --- |
| `npm run dev` | Vite on <http://localhost:5173>, after `prepare-assets`. Pick an example, press **Run kernel**; the first run downloads the toolchain in-browser. |
| `npm run build` | `tsc --noEmit`, then `website/dist`. |
| `npm test` | The unit suite. No driver and no wasm build needed. |
| `npm run test:toolchain` | Compiles a fixture and checks what came out: an AMDGCN ELF for the requested arch, a wasm host module importing the CUDA entry points, the kernel symbol unmangled with its descriptor. A bad arch or toolchain id is refused. |
| `npm run test:simulator` | Runs compiled fixtures in the wasm simulator: that a kernel completes, that a three-launch kernel runs all three, that an LDS kernel executes, that a truncated code object is refused. |
| `npm run test:correctness` | Every kernel in `tests/fixtures/` against a CPU reference computed independently in `tests/lib/cpu-reference.mjs`, comparing **every** output element. The fixtures are mirrors of `src/examples` with only their size constants changed. |
| `npm run test:lds` | The bank-conflict analysis: a strided LDS read reports a conflict, padding the stride removes it, the reported stride matches what each fixture strides by, and the kernel still computes the right answer either way. |
| `npm run test:all` | All four of the above. Each compiles fixtures through the real toolchain and runs them in the real simulator, so they need `make -C toolchain llvm` and `make -C simulator wasm` first; each reports what is missing and skips rather than failing. `make website-test` calls it. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run smoke` | `libcudart.ts` driven against `/tmp/sim-runner.wasm`, `/tmp/wasm_exec.js`, and the Vectoradd artifacts in `toolchain/build/smoke`. |
| `npm run compile-smoke` | The compile pipeline end to end, printing each stage and both artifact sizes. |
| `npm run class-audit` | Class names used with no rule, and rules with no user. |

Build-time variables: `VITE_BASE_PATH` (site base path, for a GitHub Pages
`/<repo>/` subpath), `VITE_DRIVER_ENCODING` (`br` or `raw`; Pages ignores
`public/_headers`, so it needs `raw`), and
`VITE_OTLP_METRICS_ENDPOINT` (optional; when set the worker also POSTs the OTLP
metrics body to your collector).

The runtime dependencies are `@wasmer/sdk`, `monaco-editor`, React, and three d3
submodules — `d3-scale`, `d3-shape`, `d3-array`. d3 computes chart geometry and
React renders it; there is no `d3-selection`, no imperative DOM, and no second
rendering model competing with React for a subtree. The full `d3` package would
add ~60 KB gzipped of DOM and transition machinery this app does not use.

There is no build-time target arch. The ISA a compile emits is a fact about the
device the learner selected, which the simulator's catalog reports alongside the
toolchain that produces it; both travel on the compile request and the browser
resolves them through `../toolchain/toolchains.json`. A build told one arch could
only ever emit for that arch, which is why the value is gone rather than
overridable.

The catalog lists every device the simulator registry holds, but carries the
figures of one of them: reading a device's clock and cache sizes means building
that device's platform, which costs hundreds of megabytes of Go heap that Go does
not give back. So the page-load read pays for the default device's platform, and
selecting a device nobody has run on posts a `catalog-request` for it -- one
platform, at the moment the selection moves. Device memory is the exception: it
comes off the platform configuration rather than off a built platform, so every
entry carries it and the device select can show it for all of them.

## The editor

`src/lib/cudaLanguage.ts` is what the editor knows and `src/lib/cudaSymbols.ts`
is what it can navigate. Monaco ships no CUDA language and no C++ language
*service* — its `cpp` support is a tokenizer and nothing else — so completion,
hover, signature help, go-to-definition and find-references are built here from
two tables that all five features read, so they cannot drift apart:

- **Completion** — CUDA intrinsics, the runtime API, types, host libc, six
  structural snippets (a kernel, a shared tile, a block reduction, an atomic
  accumulation), and identifiers already in the buffer. Ranked by intent rather
  than alphabetically.
- **Hover** — one line per CUDA symbol, and "no note for this one yet" rather
  than an empty tooltip when a symbol has none.
- **Signature help** — for the runtime calls only. A guessed arity shown as
  authoritative is worse than no signature.
- **Go to definition / find references** (Ctrl+click, F12, Shift+F12) — macros,
  functions and kernels in the file, including a kernel launched from a `main`
  further down, and the CUDA API, which resolves into a synthetic header generated
  from the same tables.
- **Find** — Ctrl+F and Ctrl+H work natively; there is also a "Find in Code"
  context-menu entry, because a chord nobody is told about is not a feature.

  All of the above depends on the editor contributions being imported
  individually at the top of `CudaEditor.tsx`.
  `monaco-editor/editor/editor.api` is the API surface **alone** and pulls in none
  of them — no hover, no suggest, no find, no go-to-definition, no links, no
  parameter hints, no context menu, no snippet expansion. Importing the whole of
  `editor.main` costs 323 KB gzipped for contributions this app never uses, so the
  twelve that matter are named one by one; `tests/editor-contribs.test.mjs` holds
  that list to the features.
- **Lint** — see `lintCuda`, which is deliberately narrow: every rule is
  decidable from the text alone, and a wrong squiggle in an editor a learner
  trusts teaches them to ignore the column.

## Output

The four panels:

- **Console** — the compile and run log.
- **Dashboard** — the live readout and nothing else. DRAM traffic over simulated
  time, active SIMD lanes, active compute units, device memory, and cache and TLB
  hit rates, all while the kernel is still running.

  The panel **draws a schema the simulator sends**, and the schema is the only thing
  it draws. Before each run the worker calls the `dashboardSchema` export, which
  returns the charts, their units, the sample paths each line reads, the hierarchy
  rows and the hit-rate meters, all read off the platform the harness actually built.
  Every one of those is a device fact — which cache levels exist, how many lanes there
  are, what the headings say — and a list of them written in the website is a guess
  about hardware made in the wrong layer. A schema is data, so a device that gains a
  level needs no website change at all. `harness/dashboard.go` is the Go half and
  `src/lib/protocol.ts` mirrors it field for field.

  A traffic chart carries **one series per kernel**, so a run of two kernels says which
  one moved the traffic instead of reporting one total. The simulator keeps an entry
  per distinct kernel name, so a kernel in a loop is one series, and attributes
  traffic on every sample: each series rises while its kernel runs and is flat before
  and after. **Hue is the kernel and the dash is the direction**, because a hue may
  repeat across kernels but a dash is only ever read or write.

  The one thing the panel interprets is `valueKind`. A sample is cumulative and
  carries no rates, so `"rate"` means "difference two consecutive samples and divide
  by the simulated time between them" — which is also why a rate chart's points are
  indexed by interval rather than by sample. `"value"` plots a field as it stands
  and `"bytes"` plots a byte count in MiB.

  The figures arrive during the run. Everything except the throughput charts is **to
  date** — a mid-run hit rate is the ratio of two monotonic counters so far, so it
  converges on its final value rather than fluctuating around it — and throughput
  is differenced between consecutive samples against the engine's clock.

  The occupancy charts plot **counts**, with the device's ceiling drawn as a dashed
  line. A percentage is bounded at 100 by definition, so it cannot show that one
  device has 256 lanes and another 64, and it cannot be read against the ceiling;
  a count is the number the hardware has and the number in use.

  DRAM is headed by totals — "196.50 KiB read · 64.00 KiB written, since launch"
  — rather than a rate. A rate at one instant is a difference between two samples,
  so it changes with where the cursor would have been, and "0.0 MB/s" for writes
  reads as "this kernel wrote nothing" when it means "nothing moved in the last
  40 ms".

  A flat write line is usually the kernel's shape, and the panel says so when it
  sees it. matmul-naive writes 64 KiB — exactly `N*N*sizeof(float)`, exactly what
  `c[row * width + col] = sum` costs — and every byte of it is written by the one
  store each thread reaches *after* its 128-input loop, so the write counters sit
  at zero until the last few samples of the run. Mid-run the panel says reads are
  flowing while writes are not; afterwards it says the writes all arrived at the
  end. Both halves of that sentence are the same fact.

  This is worth being precise about, because the obvious reading is wrong. The
  tempting explanation is that L2 is holding the dirty lines and writes them back
  at the end — but if that were the cause, the L1 and L2 write series would climb
  throughout the run and only DRAM would be flat. They are flat too, which is what
  rules it out: a store request is counted when it *arrives* at a level, so a flat
  L1 means the kernel had not issued the store yet. Writeback timing decides
  whether the bytes also cross into DRAM; it does not decide when they appear at L1.

  Getting a stored byte from L2 to DRAM takes one of exactly two things, and there
  is no idle timer anywhere in the path: the line is **evicted** because something
  else needed the set, or the **host reads the range back**. A launch marks the
  whole buffer set L2-dirty, and a `cudaMemcpy` that overlaps a dirty buffer makes
  the driver flush the caches before it copies. So in practice the flush is caused
  by your own `cudaMemcpy` of the result, which is why the write cliff lands where
  the read-back is rather than at the end of the kernel.

  Two things follow, and both are worth knowing before reading a chart:

  - A program that writes its output and **never reads it back never flushes**, so
    the DRAM write line stays flat for the entire run. That is a true reading of the
    hardware, but it looks exactly like a broken counter.
  - Reading results back once after a loop of many launches puts every writeback
    on that single copy, which is a real cliff rather than an artefact. Reading
    back per iteration spreads the same traffic across the run.

  Under capacity pressure neither caveat applies: drive the working set past L2 and
  the DRAM write figure climbs sample by sample, because eviction does not wait for
  anyone.

### Customize: sizes the platform is built from

The Customize tab sets the L1 (per CU), L2, MALL and device memory the next run is
built from, and **Save configuration** rebuilds the simulator so they take effect.
The rebuild is the point rather than an inconvenience: the sizes reach MGPUSim's
builders, so the harness holding the old platform has to be discarded — a harness
cannot be reconfigured in place, only replaced.

Validation happens in three places, and the third is the authority:

| where | what it does |
|---|---|
| `akita` cache builders | refuse `TotalByteSize` that leaves **zero sets**, at build time |
| `harness.ValidateSizeOverrides` | the floors, checked by `New` and by the wasm export |
| `website/src/lib/deviceOverrides.ts` | the same floors, per field, before the rebuild is paid for |

The builder check is the one that matters most. akita derives a cache's set count as
`TotalByteSize / (WayAssociativity * blockSize)` and every lookup then computes
`hashedAddr % numSets`, so too small a cache does not fail to build — it panics with
an integer divide by zero on first touch, deep inside a run, where it reads as a
simulator bug rather than the misconfiguration it is. The message names the
arithmetic so the fix is obvious:

```
L2 cache of 262144 B is too small for 16-way 64-byte lines; one set needs 1024 bytes
```

The floors themselves are derived rather than guessed: one set is
`16 ways x 64 B = 1024 B`, the L2 is split across `numMemoryBank` (16 on both
devices), so the minimum for a set per bank is 16 KiB — and the floor is set at
**64 KiB**, four sets per bank, because one set per bank holds 16 lines in total and
conflicts on everything. L1V has its own floor (4 KiB): it is built per CU and
computes correctly there.

`deviceOverrides.ts` computes the floors from those three numbers rather than
restating them, so the browser and the simulator cannot drift into disagreeing about
what is buildable. Where the two genuinely cannot share a derivation — a MALL size
on a device that has no MALL, which the builders ignore — both sides skip the check
for the same reason, and `Device.HasMALL` is asserted against the catalog's derived
`memLevels` so the registry flag and the built platform cannot disagree either. A value at or above `2^32` is refused there too, because
`//go:wasmexport` takes an `i32` and a larger size arrives as a different number
rather than as an error.

### The memory hierarchy strip

DRAM is the bottom of a chain, so the panel draws each level's request bytes from
the launch, innermost first, DRAM last:

| | L1 | L2 | MALL | DRAM |
|---|---|---|---|---|
| **gcn3generic**, matmul-naive 128² | 14537 KiB | 1286 KiB | — | **192 KiB** |
| **cdna3generic**, matmul-naive 128² | 14521 KiB | 1292 KiB | **192 KiB** | **0.13 KiB** |

The numbers are the same kernel on two devices, and the row that differs is the
answer to "why is CDNA3's DRAM read throughput nearly empty". **CDNA3 puts a 256 MB
MALL (Infinity Cache) between L2 and DRAM and the GCN3 device has nothing there.** Its
L2 misses are the same size as the GCN3 device's DRAM traffic — 192.38 KiB and 3078
transactions, to the byte — but they are served by the MALL, which is large enough
to hold the entire working set. So DRAM sees almost nothing, and that is a working
cache rather than a broken metric.

Two consequences worth knowing before changing anything here:

- **The set of levels is not the same on every device**, so the sample carries them
  in a `memLevels` map rather than as fixed `l1ReadBytes`-style fields, and OTLP
  emits `hipy.simulator.mem.level.bytes` tagged by `hipy.mem.level`. A level a device
  does not have is **absent**, never zero: "the GCN3 device has no MALL" and "the MALL
  saw no traffic" are different claims.
- **MALL is not *named* `Cache`.** The component is `GPU[0].MALL[0]`, so the
  tracer-registration case matches it separately.

Each level counts requests that **arrived at it from below**. A store is counted at
every level it reaches, so a level showing more traffic than the one under it means
something stopped on the way down. `dramTracer` (`harness/metrics.go`) does the
counting at every level for the same reason.

L1 sums the L1V, L1S and L1I of every shader array into one row, because one L1
figure is what a reader wants; the finished body's `CacheHitRate` keeps the three
apart where the split matters.

  Samples arrive about every 40 ms of wall clock, so a short kernel gets a dozen
  of them and a long one gets hundreds. The browser keeps a rolling 160 and the
  panel says when it has dropped any — a chart of the last six seconds of a
  minute-long run, presented as the run, is worse than a shorter chart that admits
  it.

  Every chart has Grafana-style controls: scroll to zoom about the cursor,
  shift+scroll to pan, drag to select a range, hover for a crosshair and a value
  readout, click a legend entry to hide a series, and reset when zoomed. The
  arithmetic is in `src/lib/chart/view.ts` as pure functions over sample indices,
  because a chart that zooms to the wrong window still *looks* like a chart.

  Charts draw at 1:1 with CSS pixels, sized by a `ResizeObserver` on their host. A
  viewBox scaled to the pane with `preserveAspectRatio="none"` would stretch every
  glyph wider than it is tall.

  DRAM traffic is measured **from the launch**, not from the start of the program.
  The host-to-device copies and any memset that set a kernel up are themselves
  DRAM writes and all happen before the first instruction, so an unbaselined write
  series is a flat line at the setup cost for the whole run. Past that, a kernel
  whose output also fits in L2 — every kernel here — tends to write nothing more
  until it emits its result, and the panel says when it sees that shape.

  Device memory is modelled at 16 MiB (GCN3) and 32 MiB (CDNA3) — far below
  either card's real capacity, and deliberately: at a realistic GiB figure every
  shipped example sits under a percent of the device for a whole run, so the limit
  is not something a program can approach. At these sizes a doubled workspace is
  visible as it doubles, and a program can actually reach the ceiling and be
  refused.
- **LDS** — one row per distinct `__shared__` access pattern, and for the selected
  one a bank map whose column height is the distinct addresses that bank saw in one
  phase. Taller than one is a conflict. Below it, the per-lane table.

`src/examples/` is the picker's list, globbed: a `.cu` there appears whether or
not the manifest names it, and one the manifest does not name falls back to a
label derived from its filename. The manifest's per-example `expect` is what the
smokes compare stdout against, and it records the expected allocation and
host-to-device copy counts as well as the text.

The examples that need more than one buffer keep them in one allocation where the
shape allows it, and every kernel takes either one pointer or three. The reason is
the host runtime's argument ABI: `hipLaunchKernel` receives a bare `void *[]` of
argument addresses with no count, and the count is not recoverable from anything
else -- not from `__hipRegisterFunction`, whose five metadata words are all zero,
nor from the V5 kernel descriptor. So the count has to come from the array itself.

`kernelArgSlots` in `src/lib/libcudart.ts` recovers it from the property clang does
give: the slots are consecutive words. It stops at the first slot that leaves that
run, caps the read, and refuses a list with no terminator by name, so the count does
not depend on a zero word clang never promised to write.

A kernel taking one pointer to a struct of arguments needs none of this: the count
is 1. That is the shape the examples use wherever they can, and it is the shape to
prefer. `prefixsum.cu` says the whole argument at length.

The same applies to shared memory, though less predictably. Two separate
`__shared__` arrays can land 256 bytes apart, and clang merges reads across them
into an LDS read pair the emulator does not implement, so an example needing
several LDS buffers declares one array and slices it. But the pairing is really a
property of any two-address LDS access with a constant stride, not of how many
arrays are declared: `histogram.cu` reaches it from a single array as soon as a
fold loop strides by the bin count. The rule that actually holds is to keep shared
accesses contiguous. `topk-bisect.cu` and `histogram.cu` show the two shapes.

Kernel fixtures live in `simulator/testdata/fixtures.json`, which the Go
tests, both smokes, and these tests read. The compiler toolchains and the devices
each serves live in `../toolchain/toolchains.json`, read by `src/lib/toolchains.ts`
in the browser and by `../toolchain/src/scripts/toolchain-args.mjs` on the shell
side; `prepare-assets.mjs` stages one driver and one sandbox archive per toolchain
under `public/toolchain/<id>/`, and a compile fetches only the one its device names.

`sim-runner.wasm` imports one thing: `env.pushMetrics`, the live gauge stream. wasm
resolves imports at instantiation, so a missing one is a hard failure there rather
than a nil call later:

```
WebAssembly.instantiate(): Import #25 module="env" error: module is not an object or function
```

Every consumer must supply it, and with the production callback rather than a no-op:
the pointer it is handed arrives sign-extended, so an address at or above
`0x80000000` is negative unless coerced, and the CDNA3 platform's heap grows past
2 GiB while the GCN3 device's stays near 0.3 GB.

```js
import { createMetricsStream } from "./src/lib/metricsStream.ts";

const { instance } = await WebAssembly.instantiate(simBytes, {
  ...go.importObject,
  env: {
    ...(go.importObject?.env ?? {}),
    pushMetrics: createMetricsStream({
      memory: () => instance?.exports.mem ?? null,
      onMetrics: (sample) => post({ type: "metrics", metrics: sample }),
      onUnreadable: (message) => console.warn(message),
    }),
  },
});
```

The stream exists because the whole simulation runs inside **one** synchronous
`drain()` call, so the worker thread is blocked for its duration: no page-to-worker
message can be serviced, and a Go `time.Ticker` never fires (timer delivery needs a
JS event-loop turn, which needs an empty stack). Go has to push, from a tracing hook
that already runs on the engine goroutine — which also makes the sample race-free,
because that is the goroutine writing the counters being read.

v1 supports static `__shared__` memory, fp32, no CUDA libraries, and the
GCN3 or the CDNA3 devices. Each boundary is rejected at compile or launch with
a message naming it; `toolchain/boundaries.json` is the table both the compile
suite and the About tab read, and the editor footer renders its compile-time rows
as a one-line summary.