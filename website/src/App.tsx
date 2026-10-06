import { useEffect, useMemo, useRef, useState } from "react";
import { contentHash, exampleIdFromGlobKey, exampleLabel, selectedExampleId, type ExampleDefinition } from "./lib/exampleSelection";
import manifest from "../../simulator/testdata/fixtures.json";
import { CudaEditor } from "./editor/CudaEditor";
import { CustomizePanel } from "./components/CustomizePanel";
import { Console, type ConsoleEntry } from "./components/Console";
import { Dashboard } from "./components/Dashboard";
import { deviceChangedSinceRun } from "./lib/deviceConfig";
import { describedDevice, deviceOptions, formatCacheBytes, selectDevice, targetArchFor, toolchainFor, unknownFigure } from "./lib/catalog";
import type { CatalogBody, CatalogDevice, DeviceOption } from "./lib/catalog";
import { LdsInspector } from "./components/LdsInspector";
import { PaneDivider, storedEditorWidth } from "./components/PaneDivider";
import { ToolchainBoundaries } from "./components/ToolchainBoundaries";
import { selectLdsModel } from "./lib/ldsModel";
import { validateOverrides } from "./lib/deviceOverrides";
import type {
  CompileResponse,
  Metrics,
  DashboardSchema,
  SimOverrides,
  SimRequest,
  SimResponse,
  TelemetryBundle,
} from "./lib/protocol";
import { parseClangDiagnostics, type CompilerDiagnostic } from "./lib/compilerDiagnostics";
import { routeSimMessage } from "./lib/simMessages";
import { applySimEffects, METRICS_LIMIT } from "./lib/simEffects";

const DEFAULT_EXAMPLE_ID = "reduction";

const exampleModules = import.meta.glob("./examples/*.cu", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The picker labels come from the manifest's per-example title, so the name a user
// reads is the one the harness, the fixtures and the example test all share. An
// example the manifest does not list still appears and falls back to the derived
// label.
const exampleTitles = new Map<string, string>(
  manifest.examples.map((entry) => [entry.id, entry.title ?? ""]),
);

const examples: readonly (ExampleDefinition & { label: string })[] = Object.entries(exampleModules)
  .map(([path, source]) => {
    const id = exampleIdFromGlobKey(path);
    return { id, label: exampleLabel(id, exampleTitles.get(id)), source, contentHash: contentHash(source) };
  })
  .sort((left, right) => (left.id === DEFAULT_EXAMPLE_ID ? -1 : right.id === DEFAULT_EXAMPLE_ID ? 1 : left.id.localeCompare(right.id)));
// Where the editor's source is kept between visits. A schema change under this
// key discards the old value; initialSource() falls back to the default example,
// so nobody gets an empty editor.
const storageKey = "hipy:hip-source:v1";
// No instruction cutoff: 0 installs no stopper, so a run goes until the kernel
// finishes. A cap truncated a long kernel into a partial result indistinguishable
// from a complete one. A kernel that never terminates now runs forever; restarting
// the simulator is the way out.
const maxInstructions = 0;
// How many live samples are held. The cap and the reasoning behind dropping the
// oldest rather than the newest live in lib/simEffects.ts.
const tabs = ["Console", "Dashboard", "LDS", "Customize", "About"] as const;
type Tab = typeof tabs[number];
// A run that failed can still hand back a telemetry bundle, and that bundle always
// carries the LDS body, so the LDS tab has exactly as much partial data as Dashboard
// does.
const telemetryTabs: readonly Tab[] = ["Dashboard", "LDS"];
type Stage = "idle" | "downloading" | "device" | "host" | "link" | "simulating" | "complete" | "cancelled" | "error";

// SimStatus is the simulator module's own state. "ready" means a Go instance is
// built and can accept a run; "crashed" means the runtime died and the worker will
// refuse everything until it is replaced.
type SimStatus = "starting" | "ready" | "crashed";

const simStatusLabels: Record<SimStatus, string> = {
  starting: "Simulator starting",
  ready: "Simulator ready",
  crashed: "Simulator stopped",
};

const stageLabels: Record<Stage, string> = {
  idle: "Ready",
  downloading: "Downloading toolchain",
  device: "Compiling device",
  host: "Compiling host",
  link: "Linking WASM",
  simulating: "Simulating GPU",
  complete: "Run complete",
  cancelled: "Cancelled",
  error: "Run failed",
};

function initialSource(): string {
  const fallback = examples.find((example) => example.id === DEFAULT_EXAMPLE_ID)?.source;
  if (fallback === undefined) {
    throw new Error(`default example ${DEFAULT_EXAMPLE_ID} is missing from src/examples`);
  }
  try {
    return localStorage.getItem(storageKey) ?? fallback;
  } catch {
    return fallback;
  }
}

function workerError(event: ErrorEvent): string {
  return event.message || "worker terminated unexpectedly";
}

export function App() {
  const [source, setSource] = useState(initialSource);
  const [activeTab, setActiveTab] = useState<Tab>("Console");
  const [partialTelemetry, setPartialTelemetry] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  // The Customize sizes for the next run. Held here rather than in the panel
  // because the panel is a view over them: a run can be started from the toolbar
  // with the panel closed.
  const [overrides, setOverrides] = useState<SimOverrides>({});
  // True between posting a save and its answer, because the save rebuilds the
  // platform and the button has to be disabled for the duration.
  const [configuring, setConfiguring] = useState(false);
  // Per-field messages from the last save attempt, keyed by override name. Empty
  // rather than absent when nothing is wrong, so the fields are not looking for an
  // error that is not there.
  const [overrideErrors, setOverrideErrors] = useState<Record<string, string>>({});
  // The simulator MODULE's health, which is not the same question as what the current
  // run is doing: a crashed Go runtime leaves the worker refusing work while the run
  // stage says "Run failed", and "failed" reads as "try again".
  const [simStatus, setSimStatus] = useState<SimStatus>("starting");
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryBundle | null>(null);
  // The live samples, oldest first, capped. The cap and the choice to drop the
  // oldest rather than the newest live in lib/simEffects.ts.
  const [samples, setSamples] = useState<Metrics[]>([]);
  // How the live stream should be drawn, as the run in flight's simulator reported
  // it. Null between runs and before the first one, and null forever if the build
  // has no dashboardSchema export. Replaced rather than merged per run: it describes a
  // PLATFORM, so a schema that outlived the run it came from would draw one
  // device's samples against another's rows and units.
  const [dashboardSchema, setDashboard] = useState<DashboardSchema | null>(null);
  const [download, setDownload] = useState<{ loaded: number; total: number | null } | null>(null);
  const [diagnostics, setDiagnostics] = useState<CompilerDiagnostic[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  // The catalog's own default. The empty string until it arrives, and the select is
  // disabled until then, so there is nothing to select and nothing to guess. A name
  // typed here would be right for one build and a device the simulator cannot build
  // for every other.
  const [device, setDevice] = useState("");
  // What the simulator is, as its own catalog export reported it. Null until the
  // worker answers, and null forever if the read failed -- in which case
  // catalogError says why and the select stays disabled.
  const [catalog, setCatalog] = useState<CatalogBody | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // The device the results on screen came from, recorded when a run starts. Null
  // until then, which is the "nothing has been run" case rather than a divergence.
  // It exists because the About tab, the editor footer and the LDS caveat all name
  // the SELECTED device while the telemetry names the one that was run.
  const [lastRunDevice, setLastRunDevice] = useState<string | null>(null);
  const compilerRef = useRef<Worker | null>(null);
  // The workspace element, which is what the divider measures the available width
  // against. A ref rather than state: the divider reads it on pointer events and
  // does not re-render this component when it changes, which it never does.
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  // The editor's width in pixels, or null while the grid is still on the CSS
  // default ratio. Null is a state and not a number: nothing has been dragged yet,
  // and writing a pixel value here on mount would freeze a ratio the reader can
  // still change by resizing the window.
  const [editorWidth, setEditorWidth] = useState<number | null>(storedEditorWidth);
  // The sim worker, created at page load rather than per run.
  //
  // sim.worker.ts reads the catalog off the Go module at MODULE load, the only
  // point at which there is something to read it with. A worker built inside the
  // compile-complete handler would have no catalog to give until after a run is
  // requested, and would build the module twice on that first run.
  const simRef = useRef<Worker | null>(null);
  // Resolves with the worker once it has posted `ready`, which it does only after
  // its startup chain has finished -- the wasm fetch, the instantiate, the catalog
  // read. A request landing before the startup chain has assigned the worker's
  // `pending` instance makes the run build a second module of its own.
  const simReadyRef = useRef<{ promise: Promise<Worker>; resolve: () => void } | null>(null);
  // The run a message from the sim worker belongs to, or null when no run has posted
  // a request. Held rather than closed over because the handlers are wired once, at
  // page load, and a run id captured then would be the page's first run id for the
  // life of the page.
  const simRunRef = useRef<number | null>(null);
  const runIdRef = useRef(0);
  const entryIdRef = useRef(0);
  const firstRunRef = useRef(true);
  const startedAtRef = useRef(0);
  const selectedExample = selectedExampleId(source, examples);
  // The device select's options and the About tab's figures are the same two reads
  // of the same body, so a second device cannot render one device's numbers beside
  // another's name.
  const options = deviceOptions(catalog);
  // Null rather than the first device. A caller handed null has to decide what to
  // show, and that decision is the one a guess takes away.
  const selected: CatalogDevice | null = selectDevice(catalog, device);
  // The arch, null for the same reason and refused downstream rather than defaulted
  // to. The run and the About row read this one value, so the figure a reader reads
  // and the figure a run meets cannot drift apart.
  const arch = targetArchFor(catalog, device);
  // The toolchain with it, from one lookup, because a compile needs both. Null is
  // refused the same way `arch` is: there is no build-time ISA to fall back to.
  const toolchain = toolchainFor(catalog, device);
  // The metrics body is read, validated and forwarded to a collector when
  // VITE_OTLP_METRICS_ENDPOINT is set, so a broken export is reported rather than
  // silently ignored.
const metrics = telemetry?.metrics ?? null;
  // LdsInspector calls selectLdsModel again on this body; left as is, since folding
  // it away means passing a derived model through a prop that must accept null
  // anyway.
  const ldsModel = useMemo(
    () => (telemetry ? selectLdsModel(telemetry.lds, arch) : null),
    [telemetry, arch],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (startedAtRef.current > 0) setElapsedMs(performance.now() - startedAtRef.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  // Creates the sim worker and wires its messages. One function because the worker
  // is made twice: here at page load, and again by a run whose worker cancel()
  // terminated underneath it.
  const startSim = (): Worker => {
    const worker = new Worker(new URL("./workers/sim.worker.ts", import.meta.url), { type: "module" });
    simRef.current = worker;
    // Captured in a local rather than read back out of the ref when the message
    // arrives: a cancel can leave a superseded worker with a `ready` still in
    // flight, and resolving the CURRENT worker's promise from it would let a run
    // post to a worker that has not finished starting.
    let resolveReady: () => void = () => {};
    const record = {
      promise: new Promise<Worker>((resolve) => { resolveReady = () => resolve(worker); }),
      resolve: () => resolveReady(),
    };
    simReadyRef.current = record;

    worker.onmessage = (event: MessageEvent<SimResponse>) => {
      // What a message MEANS is routeSimMessage's business and is answered purely,
      // without React; what the page DOES about it is applySimEffects'. See
      // lib/simMessages.ts.
      applySimEffects(
        routeSimMessage(event.data, { runId: simRunRef.current, currentRunId: runIdRef.current }),
        {
          setCatalog,
          setCatalogError,
          setSimStatus,
          setDevice: (name) => setDevice((current) => (current === "" ? name : current)),
          setStage,
          setActiveTab,
          appendConsole,
          appendMetrics: (sample) => {
            setSamples((prior) => [...prior, sample].slice(-METRICS_LIMIT));
          },
          setDashboard,
          clearMetrics: () => {
              setSamples([]);
              setDashboard(null);
              setTelemetry(null);
              // The run these numbers came from is off the screen along with them,
              // so the record of which device produced them goes too.
              //
              // null, not "": deviceChangedSinceRun tests lastRun !== null, and an
              // empty string is a name no device has, so it would read as a
              // divergence from every selected device.
              setLastRunDevice(null);
            },
          setTelemetry,
          setPartialTelemetry,
          setConfiguring,
          resolveReady: record.resolve,
          onRunComplete: () =>
            appendConsole("status", `Run complete in ${((performance.now() - startedAtRef.current) / 1_000).toFixed(2)} s.`),
          endRun: () => {
            // Clearing the run id is what stops a late message from a finished run
            // being rendered onto the next one. The worker is deliberately left
            // running: the isolation between runs is the fresh Go instance the
            // worker builds per run, and terminating here would force a second
            // platform build on the next click.
            simRunRef.current = null;
          },
        },
      );
    };
    worker.onerror = (event: ErrorEvent) => {
      const message = workerError(event);
      // Terminated on every branch: an uncaught error leaves the worker in an
      // unknown condition, and neither a terminated one nor one left in the ref is
      // worth posting a run request to.
      worker.terminate();
      // Guarded: a superseded worker can still report an error after a cancel
      // replaced the ref, and clearing it then would strand the worker the next run
      // is about to use.
      if (simRef.current === worker) simRef.current = null;
      const runId = simRunRef.current;
      // A run id that is no longer current is dropped rather than reported: it
      // belongs to a run that has already ended or been cancelled.
      if (runId !== null && runId !== runIdRef.current) return;
      appendConsole("stderr", `Simulation worker: ${message}`);
      // No run in flight, so this is a failure to read the simulator's own
      // description of itself and the select stays disabled rather than offering a
      // list nobody can vouch for.
      if (runId === null) {
        setCatalogError(message);
        return;
      }
      simRunRef.current = null;
      setStage("error");
    };
    worker.onmessageerror = () => {
      // Unlike onerror above, the worker is left in place: a message the page could
      // not deserialise says nothing about the worker's health.
      if (simRunRef.current === null) return;
      if (simRunRef.current !== runIdRef.current) return;
      simRunRef.current = null;
      setStage("error");
      appendConsole("stderr", "Simulation worker returned an unreadable message.");
    };
    return worker;
  };

  // The sim worker a run posts its request to: the page-load one if it is still
  // there, a new one if a cancel took it. Not unconditional: the instance the
  // catalog was read from is the one thing run 1 reuses.
  const sim = (): Promise<Worker> => {
    if (simRef.current === null || simReadyRef.current === null) startSim();
    return simReadyRef.current!.promise;
  };

  useEffect(() => {
    startSim();
    return () => {
      // The unmount, not a run, ends the page-load worker's life, so this is
      // deliberately the only place outside cancel() that terminates it. The run id
      // is bumped first so a message already in flight is dropped.
      runIdRef.current++;
      compilerRef.current?.terminate();
      simRunRef.current = null;
      simRef.current?.terminate();
      simRef.current = null;
      simReadyRef.current = null;
    };
  }, []);

  // Replaces the simulator module after a crash.
  //
  // A dead Go runtime cannot be revived: the worker refuses further work by design,
  // so the only recovery is a new worker, which builds a fresh instance. That costs
  // a platform rebuild, so it is an explicit button rather than something done
  // silently behind a "Run". The Dashboard is left alone: its numbers came from the
  // run that crashed and they are still the truth about it.
  const restartSimulator = (): void => {
    simRunRef.current = null;
    simRef.current?.terminate();
    simRef.current = null;
    simReadyRef.current = null;
    setSimStatus("starting");
    setStage("idle");
    startSim();
    appendConsole("status", "Restarting the simulator.");
  };

  const appendConsole = (kind: ConsoleEntry["kind"], text: string): void => {
    setEntries((current) => [...current, { id: entryIdRef.current++, kind, text }]);
  };

  const appendDiagnostics = (output: string): void => {
    const parsed = parseClangDiagnostics(output);
    if (parsed.length > 0) setDiagnostics((current) => [...current, ...parsed]);
  };

  const cancel = (): void => {
    if (stage === "idle" || stage === "complete" || stage === "error" || stage === "cancelled") return;
    runIdRef.current++;
    compilerRef.current?.terminate();
    // The sim worker goes too: it may be mid-simulation and there is no other way
    // to take the thread back.
    simRef.current?.terminate();
    compilerRef.current = null;
    simRef.current = null;
    simRunRef.current = null;
    setStage("cancelled");
    setDownload(null);
    appendConsole("stderr", "Run cancelled. Workers terminated.");
  };

  const run = (): void => {
    if (stage !== "idle" && stage !== "complete" && stage !== "error" && stage !== "cancelled") return;
    compilerRef.current?.terminate();

    const runId = ++runIdRef.current;
    startedAtRef.current = performance.now();
    const isFirstRun = firstRunRef.current;
    firstRunRef.current = false;
setStage("downloading");
    setEntries([]);
    setTelemetry(null);
    setSamples([]);
    setDashboard(null);
    setPartialTelemetry(false);
    setDownload(null);
    setDiagnostics([]);
    setElapsedMs(0);
    setActiveTab("Console");
    // The run makes the selection current: from here the telemetry and the derived
    // text agree by construction, so the select's marker clears. Recorded at the
    // start rather than on completion because a failed run leaves no telemetry to
    // disagree with.
    setLastRunDevice(device);
    // The reader stays on the Console for the compile. The Dashboard is taken over
    // when the compile succeeds, because until then it has nothing to draw.
    appendConsole("status", "Run started. Compiling CUDA source.");

    const compiler = new Worker(new URL("./workers/compiler.worker.ts", import.meta.url), { type: "module" });
    compilerRef.current = compiler;

    compiler.onerror = (event) => {
      if (runId !== runIdRef.current) return;
      compiler.terminate();
      compilerRef.current = null;
      setStage("error");
      appendConsole("stderr", `Compiler worker: ${workerError(event)}`);
    };
    compiler.onmessageerror = () => {
      if (runId !== runIdRef.current) return;
      compiler.terminate();
      compilerRef.current = null;
      setStage("error");
      appendConsole("stderr", "Compiler worker returned an unreadable message.");
    };
    compiler.onmessage = (event: MessageEvent<CompileResponse>) => {
      if (runId !== runIdRef.current) return;
      const message = event.data;
      if (message.type === "download-progress") {
        if (isFirstRun) setDownload({ loaded: message.loaded, total: message.total });
        return;
      }
      if (message.type === "stage") {
        setStage(message.stage);
        if (message.stage === "device") setDownload(null);
        appendConsole("status", stageLabels[message.stage]);
        return;
      }
      if (message.type === "stdout") {
        appendConsole("stdout", message.text);
        return;
      }
      if (message.type === "stderr") {
        appendDiagnostics(message.text);
        appendConsole("stderr", message.text);
        return;
      }
      if (message.type === "error") {
        compiler.terminate();
        compilerRef.current = null;
        setStage("error");
        appendConsole("stderr", `Compile error: ${message.message}`);
        return;
      }

      compiler.terminate();
      compilerRef.current = null;
      setStage("simulating");
      appendConsole("status", "Compilation succeeded. Running the kernel.");
      // The one moment the Dashboard has something to show. A failed compile returns
      // above without getting here, and keeps the reader on the Console.
      setActiveTab("Dashboard");

      const request: SimRequest = {
        type: "run",
        hostWasm: message.hostWasm,
        deviceCodeObject: message.deviceCodeObject,
        maxInst: maxInstructions,
        // Snapshotted rather than read at delivery time: reading live state later
        // would let a Customize edit land on a run configured before it.
        overrides: { ...overrides },
        device,
      };
      simRunRef.current = runId;
      // The request must not go out before `ready`: until the startup chain has
      // assigned its `pending` instance, a request arriving there makes the run
      // build a second Go module while the first is still fetching. A correctness
      // guard rather than a delay: the compile takes seconds and the module has been
      // loading since the page opened.
      void sim().then((worker) => {
        // Cancelled while the worker was still starting: its messages are already
        // being dropped.
        if (runId !== runIdRef.current) return;
        worker.postMessage(request, [request.hostWasm, request.deviceCodeObject]);
      });
    };
    // No toolchain+arch pair means no run. The compile request's two fields are
    // required and there is no longer a build-time ISA to fall back to, so refusing
    // here says which of the two is wrong, and why.
    if (toolchain === null) {
      compiler.terminate();
      compilerRef.current = null;
      setStage("error");
      appendConsole("stderr", catalogError ?? `the simulator has no device named ${JSON.stringify(device)}`);
      return;
    }
    // The device travels with the toolchain and arch so the worker can cross-check
    // the pair against toolchain/toolchains.json before the compiler sees it.
    compiler.postMessage({ type: "compile", source, toolchainId: toolchain.toolchainId, arch: toolchain.arch, device });
  };

  const selectExample = (id: string): void => {
    const example = examples.find((item) => item.id === id);
    if (!example) return;
    setSource(example.source);
    try { localStorage.setItem(storageKey, example.source); } catch {}
  };

  // Save the Customize sizes.
  //
  // Validated here first so a value the simulator would refuse is caught before the
  // page pays for a rebuild, and so the reader is told which field is wrong. The
  // simulator validates again and stays the authority.
  const saveConfiguration = (): void => {
    if (running || configuring) return;
    const problems = validateOverrides(overrides, selected);
    setOverrideErrors(problems);
    const first = Object.values(problems)[0];
    if (first !== undefined) {
      appendConsole("stderr", `Configuration not saved: ${first}`);
      return;
    }
    setConfiguring(true);
    simRef.current?.postMessage({ type: "configure", overrides: { ...overrides } });
  };

  const selectSimulatedDevice = (name: string): void => {
    if (name === device) return;
    setDevice(name);
    setSamples([]);
    setDashboard(null);
    setTelemetry(null);
    setPartialTelemetry(false);
    // The previous run's numbers were measured on the device just left, so they go
    // too: leaving them up means a chart labelled with the new device's name is
    // drawing the old device's traffic.
    //
    // null, not "": see clearMetrics above.
    setLastRunDevice(null);
    setActiveTab("Console");
    appendConsole("status", `Switched to ${name}. The previous run's metrics were cleared.`);
  };

  const progressPercent = download && download.total && download.total > 0
    ? Math.min(100, (download.loaded / download.total) * 100)
    : null;
  const running = stage !== "idle" && stage !== "complete" && stage !== "error" && stage !== "cancelled";

  // Asks the simulator to describe the selected device whenever the body in hand
  // does not. The catalog lists every device but carries one device's figures,
  // because reading them means building that device's platform -- so the read costs
  // one platform build at the moment the selection moves, not at page load for
  // devices the learner will never look at.
  //
  // Skipped while a run is in flight, because the read builds a platform on the
  // thread the simulation occupies. `running` is in the dependency list so the
  // request goes out when the run ends rather than being lost.
  useEffect(() => {
    if (device === "" || simRef.current === null || running) return;
    const described = describedDevice(catalog);
    if (described !== null && described.name === device) return;
    simRef.current.postMessage({ type: "catalog-request", device });
  }, [catalog, device, running]);
  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          <div><span className="eyebrow">Browser GPU simulator</span><h1>HIPY Learning Playground</h1></div>
        </div>
      </header>

      {/* The editor's width rides in as a custom property rather than as a track
          size, so the narrow-viewport rule below still wins. See .workspace. */}
      <div
        className="workspace"
        ref={workspaceRef}
        style={editorWidth === null ? undefined : { "--editor-width": `${editorWidth}px` } as React.CSSProperties}
      >
        <section className="editor-pane">
          <div className="editor-toolbar">
            <label className="example-select">
              <span>Example</span>
              <select value={selectedExample ?? ""} onChange={(event) => selectExample(event.target.value)}>
                {selectedExample === null && <option value="" disabled>Custom source</option>}
                {examples.map((example) => <option value={example.id} key={example.id}>{example.label}</option>)}
              </select>
            </label>
            <label className="example-select">
              <span>Device</span>
              {/* Disabled until the catalog answers: the only list this select can
                  offer is the one the simulator reported, and an option the
                  simulator cannot build would fail once a reader picked it. */}
              <select
                value={device}
                onChange={(event) => selectSimulatedDevice(event.target.value)}
                aria-label="Simulated GPU"
                disabled={options.length === 0}
              >
                {options.length === 0 && <option value="" disabled>{catalogError === null ? "Loading…" : "Unavailable"}</option>}
                {/* Each option carries its own modelled device memory, so the figure
                    is visible for EVERY device: a reader comparing two devices is
                    standing in this dropdown. formatCacheBytes prints the same word
                    the About grid does for a figure it cannot vouch for. */}
                {options.map((option: DeviceOption) => (
                  <option key={option.value} value={option.value} disabled={option.disabled} title={option.disabledReason}>
                    {option.label} · {formatCacheBytes(option.vramBytes)}{option.disabledReason === "" ? "" : ` — ${option.disabledReason}`}
                  </option>
                ))}
              </select>
              {deviceChangedSinceRun(device, lastRunDevice) && (
                <span className="device-stale" role="status">Changed since last run</span>
              )}
            </label>
            <div className={`stage-pill stage-${stage}`}><i /><span className="stage-text">{stageLabels[stage]}</span></div>
            {/* The module's health sits beside the run's stage because they are
                different questions, and after a crash they disagree. */}
            <div className={`sim-pill sim-${simStatus}`} role="status">
              <i />
              <span>{simStatusLabels[simStatus]}</span>
              {simStatus === "crashed" && (
                <button className="button button-small" onClick={restartSimulator}>Restart simulator</button>
              )}
            </div>
            <div className="run-actions">
              {running && <span className="elapsed">{(elapsedMs / 1_000).toFixed(1)} s</span>}
              {running
                ? <button className="button button-danger" onClick={cancel}>Cancel</button>
                : simStatus === "crashed"
                  // Disabled rather than hidden: the reason it cannot run belongs on
                  // screen next to the control.
                  ? <button className="button button-primary" disabled title="Restart the simulator first">▶ Run</button>
                  : <button className="button button-primary" onClick={run}>▶ Run</button>}
            </div>
          </div>
          {download && (
            <div className="download-progress" role="status">
              <div><strong>First-run toolchain download</strong><span>{progressPercent === null ? "Preparing…" : `${progressPercent.toFixed(0)}%`}</span></div>
              <progress max={100} value={progressPercent ?? 0} />
            </div>
          )}
          <CudaEditor value={source} diagnostics={diagnostics} onChange={(value) => {
            setSource(value);
            setDiagnostics([]);
            try { localStorage.setItem(storageKey, value); } catch {}
          }} />
          <footer className="editor-footer">
            {/* The arch, from the same lookup the About row and the compile request
                use. Once the catalog is in, unknownFigure is the whole tab's
                vocabulary for a figure nobody can vouch for, so one missing number
                reads the same here and in the About grid. Before it arrives nothing
                has been reported at all, so this says "Not loaded" rather than
                unknownFigure, which would claim a measurement failed when the answer
                has not been asked for yet.

                The footer names no capability of its own; what it prints is the same
                table the About tab renders. */}
            <span>HIP · {arch ?? (catalog === null ? "Not loaded" : unknownFigure)}</span>
          </footer>
        </section>

        <PaneDivider container={workspaceRef} value={editorWidth} onChange={setEditorWidth} />

        <section className="output-pane">
          <nav className="tabs" aria-label="Output views">
            {tabs.map((tab) => (
              <button className={`${activeTab === tab ? "active" : ""} ${partialTelemetry && telemetryTabs.includes(tab) ? "partial" : ""}`} onClick={() => setActiveTab(tab)} key={tab}>
                {tab}{partialTelemetry && telemetryTabs.includes(tab) ? " · partial" : ""}
                {tab === "LDS" && ldsModel && <i className="tab-dot" />}
              </button>
            ))}
          </nav>
          <div className="tab-content">
            {activeTab === "Console" && <Console entries={entries} />}
            {activeTab === "Dashboard" && (
              <Dashboard metrics={samples} schema={dashboardSchema} running={running} />
            )}
            {activeTab === "LDS" && <LdsInspector lds={telemetry?.lds ?? null} targetArch={arch} />}
            {activeTab === "Customize" && (
                      <CustomizePanel
                device={selected}
                overrides={overrides}
                errors={overrideErrors}
                saving={configuring}
                runActive={running}
                onChange={(next) => {
                  setOverrides(next);
                  // Stale errors are worse than none: the reader fixed the field and
                  // is still told it is wrong.
                  setOverrideErrors((prior) => (Object.keys(prior).length === 0 ? prior : {}));
                }}
                onSave={saveConfiguration}
              />
            )}
            {activeTab === "About" && (
              <div className="about-view">
                {/* Every row is a hard failure, not a silent approximation: a kernel
                    that asks for a rejected header or for dynamic shared memory is
                    REJECTED rather than quietly modelled as something else. A learner
                    who hits one of these should know it is a boundary of the
                    simulator rather than a bug in their kernel, so the list is here to
                    explain the error, not to pre-empt it.

                    Each row carries its own detail and its own diagnostic, rendered in
                    the row rather than in a hover tooltip: a tooltip cannot be
                    selected, pasted or screenshotted, and matching the error on screen
                    to a row here is the one job this list has.

                    Same table as the editor footer's one-line summary, so the two
                    cannot disagree. */}
                <span className="eyebrow">Toolchain</span>
                <h3 className="about-subhead">What this toolchain will not build</h3>
                <p className="table-note">
                  Diagnostics this toolchain refuses to emit, so a missing feature reads as a
                  known limit rather than a broken build. Each one is a hard failure, not a
                  silent approximation.
                </p>
                <ToolchainBoundaries />
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
