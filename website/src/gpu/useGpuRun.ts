import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleEntry } from "../components/Console";
import type { CatalogBody, CatalogDevice, DeviceOption } from "../lib/catalog";
import { describedDevice, deviceOptions, selectDevice, targetArchFor, toolchainFor } from "../lib/catalog";
import { parseClangDiagnostics, type CompilerDiagnostic } from "../lib/compilerDiagnostics";
import { deviceChangedSinceRun } from "../lib/deviceConfig";
import { validateOverrides } from "../lib/deviceOverrides";
import { selectLdsModel, type LdsModel } from "../lib/ldsModel";
import type {
  CompileResponse,
  DashboardSchema,
  Metrics,
  SimOverrides,
  SimRequest,
  SimResponse,
  TelemetryBundle,
} from "../lib/protocol";
import { applySimEffects, METRICS_LIMIT } from "../lib/simEffects";
import { routeSimMessage } from "../lib/simMessages";

const maxInstructions = 0;

const tabs = ["Console", "Dashboard", "LDS", "Customize", "About"] as const;
export type Tab = (typeof tabs)[number];

const telemetryTabs: readonly Tab[] = ["Dashboard", "LDS"];

export type Stage =
  | "idle"
  | "downloading"
  | "device"
  | "host"
  | "link"
  | "simulating"
  | "complete"
  | "cancelled"
  | "error";

export type SimStatus = "starting" | "ready" | "crashed";

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

function workerError(event: ErrorEvent): string {
  return event.message || "worker terminated unexpectedly";
}

export type GpuRun = {
  // Toolbar
  stage: Stage;
  stageLabel: string;
  simStatus: SimStatus;
  simStatusLabel: string;
  device: string;
  options: readonly DeviceOption[];
  catalog: CatalogBody | null;
  catalogError: string | null;
  deviceStale: boolean;
  running: boolean;
  elapsedMs: number;
  download: { loaded: number; total: number | null } | null;
  progressPercent: number | null;
  arch: string | null;
  selected: CatalogDevice | null;
  // Commands
  run(): void;
  cancel(): void;
  restartSimulator(): void;
  selectSimulatedDevice(name: string): void;
  // Editor feedback
  diagnostics: CompilerDiagnostic[];
  revealLine: { line: number; at: number } | null;
  revealLineAt(line: number): void;
  noteSourceEdited(): void;
  // Output tabs
  tabs: readonly Tab[];
  telemetryTabs: readonly Tab[];
  activeTab: Tab;
  setActiveTab(tab: Tab): void;
  partialTelemetry: boolean;
  entries: ConsoleEntry[];
  samples: Metrics[];
  dashboardSchema: DashboardSchema | null;
  telemetry: TelemetryBundle | null;
  ldsModel: LdsModel | null;
  // Customize
  overrides: SimOverrides;
  setOverrides(next: SimOverrides): void;
  overrideErrors: Record<string, string>;
  configuring: boolean;
  saveConfiguration(): void;
};

export function useGpuRun({ source }: { source: string }): GpuRun {
  const [activeTab, setActiveTab] = useState<Tab>("Console");
  const [partialTelemetry, setPartialTelemetry] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
        const [overrides, setOverrides] = useState<SimOverrides>({});
  // True between posting a save and its answer, because the save rebuilds the
  // platform and the button has to be disabled for the duration.
  const [configuring, setConfiguring] = useState(false);
        const [overrideErrors, setOverrideErrors] = useState<Record<string, string>>({});
        const [simStatus, setSimStatus] = useState<SimStatus>("starting");
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryBundle | null>(null);
  // The live samples, oldest first, capped. The cap and the choice to drop the
  // oldest rather than the newest live in lib/simEffects.ts.
  const [samples, setSamples] = useState<Metrics[]>([]);
            const [dashboardSchema, setDashboard] = useState<DashboardSchema | null>(null);
  const [download, setDownload] = useState<{ loaded: number; total: number | null } | null>(null);
  const [diagnostics, setDiagnostics] = useState<CompilerDiagnostic[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
          const [device, setDevice] = useState("");
        const [catalog, setCatalog] = useState<CatalogBody | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
          const [lastRunDevice, setLastRunDevice] = useState<string | null>(null);
        const [revealLine, setRevealLine] = useState<{ line: number; at: number } | null>(null);

  const compilerRef = useRef<Worker | null>(null);
  // Counts jump requests. A ref, not state: a counter in state would re-render the
  // hook's owner to record that a button was pressed.
  const jumpCounter = useRef(0);
              const simRef = useRef<Worker | null>(null);
          const simReadyRef = useRef<{ promise: Promise<Worker>; resolve: () => void } | null>(null);
          const simRunRef = useRef<number | null>(null);
  const runIdRef = useRef(0);
  const entryIdRef = useRef(0);
  const firstRunRef = useRef(true);
  const startedAtRef = useRef(0);

        const options = deviceOptions(catalog);
  // Null rather than the first device. A caller handed null has to decide what to
  // show, and that decision is the one a guess takes away.
  const selected: CatalogDevice | null = selectDevice(catalog, device);
        const arch = targetArchFor(catalog, device);
  // The toolchain with it, from one lookup, because a compile needs both. Null is
  // refused the same way `arch` is: there is no build-time ISA to fall back to.
  const toolchain = toolchainFor(catalog, device);
        const ldsModel = useMemo(
    () => (telemetry ? selectLdsModel(telemetry.lds, arch) : null),
    [telemetry, arch],
  );

  const running =
    stage !== "idle" && stage !== "complete" && stage !== "error" && stage !== "cancelled";

  const progressPercent =
    download && download.total && download.total > 0
      ? Math.min(100, (download.loaded / download.total) * 100)
      : null;

  const appendConsole = useCallback((kind: ConsoleEntry["kind"], text: string): void => {
    setEntries((current) => [...current, { id: entryIdRef.current++, kind, text }]);
  }, []);

  const appendDiagnostics = (output: string): void => {
    const parsed = parseClangDiagnostics(output);
    if (parsed.length > 0) setDiagnostics((current) => [...current, ...parsed]);
  };

        const startSim = (): Worker => {
    const worker = new Worker(new URL("../workers/sim.worker.ts", import.meta.url), { type: "module" });
    simRef.current = worker;
                    let resolveReady: () => void = () => {};
    const record = {
      promise: new Promise<Worker>((resolve) => { resolveReady = () => resolve(worker); }),
      resolve: () => resolveReady(),
    };
    simReadyRef.current = record;

    worker.onmessage = (event: MessageEvent<SimResponse>) => {
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
                                                                                    setLastRunDevice(null);
          },
          setTelemetry,
          setPartialTelemetry,
          setConfiguring,
          resolveReady: record.resolve,
          onRunComplete: () =>
            appendConsole("status", `Run complete in ${((performance.now() - startedAtRef.current) / 1_000).toFixed(2)} s.`),
          endRun: () => {
                                                                        simRunRef.current = null;
          },
        },
      );
    };
    worker.onerror = (event: ErrorEvent) => {
      const message = workerError(event);
                        worker.terminate();
                        if (simRef.current === worker) simRef.current = null;
      const runId = simRunRef.current;
      // A run id that is no longer current is dropped rather than reported: it
      // belongs to a run that has already ended or been cancelled.
      if (runId !== null && runId !== runIdRef.current) return;
      appendConsole("stderr", `Simulation worker: ${message}`);
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

        const sim = (): Promise<Worker> => {
    if (simRef.current === null || simReadyRef.current === null) startSim();
    return simReadyRef.current!.promise;
  };

  useEffect(() => {
    startSim();
    return () => {
                        runIdRef.current++;
      compilerRef.current?.terminate();
      simRunRef.current = null;
      simRef.current?.terminate();
      simRef.current = null;
      simReadyRef.current = null;
    };
  }, []);

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

  const cancel = (): void => {
    if (!running) return;
    // The bump is first, and the order matters: it is what makes a message already
    // in flight from this run drop instead of landing on the next one.
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
    if (running) return;
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
                    setLastRunDevice(device);
    // The reader stays on the Console for the compile. The Dashboard is taken over
    // when the compile succeeds, because until then it has nothing to draw.
    appendConsole("status", "Run started. Compiling CUDA source.");

    const compiler = new Worker(new URL("../workers/compiler.worker.ts", import.meta.url), { type: "module" });
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
      // The one moment the Dashboard has something to show. A failed compile
      // returns above without getting here, and keeps the reader on the Console.
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
                                    void sim().then((worker) => {
        // Cancelled while the worker was still starting: its messages are already
        // being dropped.
        if (runId !== runIdRef.current) return;
        worker.postMessage(request, [request.hostWasm, request.deviceCodeObject]);
      });
    };
                if (toolchain === null) {
      compiler.terminate();
      compilerRef.current = null;
      setStage("error");
      appendConsole("stderr", catalogError ?? `the simulator has no device named ${JSON.stringify(device)}`);
      return;
    }
    // The device travels with the toolchain and arch so the worker can cross-check
    // the pair against toolchain/toolchains.json before the compiler sees it.
    compiler.postMessage({
      type: "compile",
      source,
      toolchainId: toolchain.toolchainId,
      arch: toolchain.arch,
      device,
    });
  };

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
                        setLastRunDevice(null);
    setActiveTab("Console");
    appendConsole("status", `Switched to ${name}. The previous run's metrics were cleared.`);
  };

  const revealLineAt = (line: number): void => {
    setRevealLine({ line, at: jumpCounter.current++ });
  };

          const noteSourceEdited = (): void => {
    setDiagnostics([]);
    setRevealLine(null);
  };

  const changeOverrides = (next: SimOverrides): void => {
    setOverrides(next);
    // Stale errors are worse than none: the reader fixed the field and is still
    // told it is wrong.
    setOverrideErrors((prior) => (Object.keys(prior).length === 0 ? prior : {}));
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (startedAtRef.current > 0) setElapsedMs(performance.now() - startedAtRef.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

                    useEffect(() => {
    if (device === "" || simRef.current === null || running) return;
    const described = describedDevice(catalog);
    if (described !== null && described.name === device) return;
    simRef.current.postMessage({ type: "catalog-request", device });
  }, [catalog, device, running]);

  return {
    stage,
    stageLabel: stageLabels[stage],
    simStatus,
    simStatusLabel: simStatusLabels[simStatus],
    device,
    options,
    catalog,
    catalogError,
    deviceStale: deviceChangedSinceRun(device, lastRunDevice),
    running,
    elapsedMs,
    download,
    progressPercent,
    arch,
    selected,
    run,
    cancel,
    restartSimulator,
    selectSimulatedDevice,
    diagnostics,
    revealLine,
    revealLineAt,
    noteSourceEdited,
    tabs,
    telemetryTabs,
    activeTab,
    setActiveTab,
    partialTelemetry,
    entries,
    samples,
    dashboardSchema,
    telemetry,
    ldsModel,
    overrides,
    setOverrides: changeOverrides,
    overrideErrors,
    configuring,
    saveConfiguration,
  };
}
