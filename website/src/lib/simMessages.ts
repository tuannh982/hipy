
import { defaultDevice, type CatalogBody } from "./catalog";
import type { Metrics, DashboardSchema, SimResponse, TelemetryBundle } from "./protocol";

export type SimStage = "idle" | "downloading" | "device" | "host" | "link" | "simulating" | "complete" | "cancelled" | "error";

export type SimStatus = "starting" | "ready" | "crashed";

export type SimTab = "Console" | "Dashboard" | "LDS" | "Customize" | "About";

export type ConsoleKind = "status" | "stdout" | "stderr";

export type SimEffect =
  | { type: "set-catalog"; body: CatalogBody }
  | { type: "set-catalog-error"; error: string }
  | { type: "clear-catalog-error" }
  | { type: "set-sim-status"; status: SimStatus }
  | { type: "set-default-device"; name: string }
          | { type: "end-run" }
  | { type: "resolve-ready" }
  | { type: "append-console"; kind: ConsoleKind; text: string }
  | { type: "set-stage"; stage: SimStage }
  | { type: "set-tab"; tab: SimTab }
  | { type: "append-metrics"; metrics: Metrics }
  // Below the run-id gate with `metrics`, because the schema describes the platform
  // THIS run was configured for.
  | { type: "set-dashboard"; schema: DashboardSchema }
  | { type: "clear-metrics" }
  | { type: "set-configuring"; value: boolean }
  | { type: "set-partial-telemetry"; value: boolean }
  | { type: "set-telemetry"; telemetry: TelemetryBundle }
  // The page reports how long the run took. Separate from the status effect because
  // the elapsed figure needs the clock, which the router does not have.
  | { type: "announce-run-complete" };

export type SimMessageContext = {
    runId: number | null;
    currentRunId: number;
};

export function routeSimMessage(message: SimResponse, ctx: SimMessageContext): SimEffect[] {
        if (message.type === "catalog") {
                    if (message.body === null) {
      return [{ type: "set-catalog-error", error: message.error ?? "the simulator reported no catalog" }];
    }
    return [
      { type: "set-catalog", body: message.body },
      { type: "clear-catalog-error" },
      // A readable catalog means a built Go instance, which is the only proof the
      // module is alive that the page gets without running a kernel.
      { type: "set-sim-status", status: "ready" },
                              ...(defaultDevice(message.body) === null
        ? []
        : [{ type: "set-default-device" as const, name: defaultDevice(message.body)! }]),
    ];
  }

  // Posted after the catalog, so this is the point at which a run's request can no
  // longer make the worker build a second module.
  if (message.type === "ready") {
    return [{ type: "resolve-ready" }];
  }

              if (message.type === "configured") {
    // A refusal changed nothing, so the reason goes to the console rather than into
    // the fields: an error beside a field the reader did not change is noise.
    if (message.error !== undefined) {
      return [
        { type: "append-console", kind: "stderr", text: `Configuration not saved: ${message.error}` },
        { type: "set-configuring", value: false },
      ];
    }
    if (message.body === null) return [{ type: "set-configuring", value: false }];
    return [
      { type: "set-catalog", body: message.body },
      { type: "clear-catalog-error" },
      { type: "set-sim-status", status: "ready" },
                              { type: "clear-metrics" },
      { type: "set-partial-telemetry", value: false },
      {
        type: "append-console",
        kind: "status",
        text: "Configuration saved. The simulator was rebuilt with it, and the previous run's metrics were cleared.",
      },
      { type: "set-configuring", value: false },
    ];
  }

  // The run-id gate. Everything below belongs to a run, so a message whose run is
  // not the current one is dropped rather than rendered onto this run's screen.
  if (ctx.runId === null || ctx.runId !== ctx.currentRunId) return [];

  if (message.type === "stdout") {
    return [{ type: "append-console", kind: "stdout", text: message.text }];
  }
  if (message.type === "error") {
    const effects: SimEffect[] = [];
                    if (message.telemetry !== undefined) effects.push({ type: "set-partial-telemetry", value: true });
    if (message.forwardingError !== undefined) {
      effects.push({ type: "append-console", kind: "stderr", text: `OTLP forwarding warning: ${message.forwardingError}` });
    }
    effects.push({ type: "set-stage", stage: "error" });
                effects.push({ type: "set-tab", tab: "Console" });
    effects.push({ type: "append-console", kind: "stderr", text: `Simulation error: ${message.message}` });
    effects.push({ type: "end-run" });
    return effects;
  }
  if (message.type === "metrics") {
                return [{ type: "append-metrics", metrics: message.metrics }];
  }
  if (message.type === "dashboard-schema") {
    // It does NOT clear the samples, unlike a device switch: the two arrive together
    // and in this order, and clearing here would empty the panel in between.
    return [{ type: "set-dashboard", schema: message.schema }];
  }
  if (message.type === "simulator-output") {
    // The simulator's own output, one line at a time: the runtime writes a panic in
    // many small pieces.
    return [{ type: "append-console", kind: message.kind, text: message.text }];
  }
  if (message.type === "crash") {
                return [
      { type: "set-stage", stage: "error" },
      { type: "set-tab", tab: "Console" },
      { type: "set-sim-status", status: "crashed" },
      {
        type: "append-console",
        kind: "stderr",
        text: `The simulator stopped (exit code ${message.code}). The lines above are its output. Restart the simulator to run another kernel.`,
      },
                        { type: "end-run" },
    ];
  }
  return [
    { type: "set-telemetry", telemetry: message.telemetry },
                ...(message.forwardingError !== undefined
      ? [{ type: "append-console" as const, kind: "stderr" as const, text: `OTLP forwarding warning: ${message.forwardingError}` }]
      : []),
    { type: "set-stage", stage: "complete" },
    { type: "set-tab", tab: "Dashboard" },
    // The elapsed figure is read by the caller, which owns the clock.
    { type: "announce-run-complete" },
    { type: "end-run" },
  ];
}
