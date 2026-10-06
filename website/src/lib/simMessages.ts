// Which simulator message reaches which handler, and which is dropped.
//
// The routing lives here rather than inside a React component's
// worker.onmessage so that "which messages does this app answer, and in what
// state" has an assertion. It is pure and does not touch React.
//
// The dispatcher is PURE. It takes the state the routing depends on and returns
// a list of effects; it mutates nothing and imports no React. App.tsx applies the
// effects. That is what makes a dropped message visible as a MISSING effect in a
// returned array rather than as an absence nobody can assert on -- which is the
// whole reason the defect above survived review.
//
// Two rules the routing follows, and they are the reason the run-id gate exists
// at all:
//
//   1. A message belonging to a run is dropped unless its run id is the current
//      one. A superseded run's output must not land on the current run's screen:
//      a chart drawn from two runs is an artifact no reader can tell from real
//      behaviour. This is why simRunRef exists at all.
//   2. A message that is NOT about a run is never subject to that gate. It has no
//      run id to match, so gating it on one drops it unconditionally. `catalog`,
//      `ready` and `configured` are all in this class.

import { defaultDevice, type CatalogBody } from "./catalog";
import type { Metrics, DashboardSchema, SimResponse, TelemetryBundle } from "./protocol";

/** The run stage labels the toolbar shows. Mirrors App.tsx's Stage. */
export type SimStage = "idle" | "downloading" | "device" | "host" | "link" | "simulating" | "complete" | "cancelled" | "error";

/** The simulator MODULE's health, which is not what the current run is doing. */
export type SimStatus = "starting" | "ready" | "crashed";

export type SimTab = "Console" | "Dashboard" | "LDS" | "Customize" | "About";

export type ConsoleKind = "status" | "stdout" | "stderr";

/**
 * One thing the page should do about a message.
 *
 * Deliberately a closed set rather than a callback: a callback would put the
 * mutating back inside the dispatcher and this would be testable only by calling
 * it, which is the arrangement that made the bug unreachable in the first place.
 */
export type SimEffect =
  | { type: "set-catalog"; body: CatalogBody }
  | { type: "set-catalog-error"; error: string }
  | { type: "clear-catalog-error" }
  | { type: "set-sim-status"; status: SimStatus }
  | { type: "set-default-device"; name: string }
  // The run this message belonged to is over, so nothing further from it may be
  // rendered. Only the router knows which messages end a run: `metrics` arrives many
  // times mid-run and must NOT end one, while `error`, `crash` and `result` each end
  // exactly one.
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

/**
 * What the routing depends on, and nothing that mutates.
 *
 * `runId` is the run a message belongs to, or null when no run has posted a
 * request -- which is the normal state between runs and the state a
 * configuration save is always in. `currentRunId` is the run the page is
 * watching, which advances on every run and on cancel.
 */
export type SimMessageContext = {
  /** The run this message belongs to, or null when none posted a request. */
  runId: number | null;
  /** The run the page is currently watching. */
  currentRunId: number;
};

/**
 * routeSimMessage decides what a message from the sim worker means, and returns
 * the effects it implies. An empty array means the message is not for this page.
 *
 * The ordering below is the contract. Page-load messages come first because they
 * are answered whether or not a run exists; the run-id gate comes next; the
 * run-scoped handlers follow it. Anything that is not about a run belongs ABOVE
 * the gate, and `configured` is the one that was not.
 */
export function routeSimMessage(message: SimResponse, ctx: SimMessageContext): SimEffect[] {
  // Delivered at page load, and again after every catalog request the page makes.
  // It is the reason this worker exists before a run does: the body is what the
  // device select offers.
  if (message.type === "catalog") {
    // A read that failed keeps whatever body is already in hand. Blanking the
    // select because a re-read was refused would replace a device list that is
    // still the simulator's own with an empty one, which is a worse answer than
    // the one on screen.
    if (message.body === null) {
      return [{ type: "set-catalog-error", error: message.error ?? "the simulator reported no catalog" }];
    }
    return [
      { type: "set-catalog", body: message.body },
      { type: "clear-catalog-error" },
      // A readable catalog means a built Go instance, which is the only proof the
      // module is alive that the page gets without running a kernel.
      { type: "set-sim-status", status: "ready" },
      // The select starts on whatever the catalog calls its default, read through
      // defaultDevice: it answers null for a default naming a device the body does
      // not list, and a select on a device nothing can render is a state the rest
      // of the page refuses to produce.
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

  // The outcome of a save, which is a reply to the PAGE and not to a run, so it sits
  // ABOVE the run-id gate. A save posts `configure` but never assigns a run id --
  // only run() does -- so gating this on a run id would drop the one reply that
  // clears the button's saving state. It is safe ungated because it answers a
  // request the page made and carries the whole configuration, so nothing in it
  // could belong to a superseded run.
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
      // The previous run's numbers are thrown away: they were measured on the
      // platform that has just been replaced. Keeping them puts a chart drawn from
      // an 8 MiB L2 under a hierarchy strip that now describes a 2 MiB one, which
      // reads as the save having corrupted the run.
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
    // A failed run can still hand back a telemetry bundle, and that bundle always
    // carries the LDS body -- readTelemetry degrades a missing ldsAnalysis export
    // to an empty analysis rather than failing the run -- so the LDS tab has
    // exactly as much partial data as Dashboard does.
    if (message.telemetry !== undefined) effects.push({ type: "set-partial-telemetry", value: true });
    if (message.forwardingError !== undefined) {
      effects.push({ type: "append-console", kind: "stderr", text: `OTLP forwarding warning: ${message.forwardingError}` });
    }
    effects.push({ type: "set-stage", stage: "error" });
    // The tab moves to the Console because the explanation is there and the reader
    // is not: every failure from the compile onwards happens with its message one
    // click away.
    effects.push({ type: "set-tab", tab: "Console" });
    effects.push({ type: "append-console", kind: "stderr", text: `Simulation error: ${message.message}` });
    effects.push({ type: "end-run" });
    return effects;
  }
  if (message.type === "metrics") {
    // Append-only, and gated by the same run id as everything else: a sample from
    // a superseded run would draw a line that jumps backwards, which is the one
    // artifact a reader cannot tell from real behaviour.
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
    // The Go runtime stopped. Its output is already in the console above it, in the
    // order the runtime wrote it, so this says what the exit means rather than
    // repeating any of it.
    return [
      { type: "set-stage", stage: "error" },
      { type: "set-tab", tab: "Console" },
      { type: "set-sim-status", status: "crashed" },
      {
        type: "append-console",
        kind: "stderr",
        text: `The simulator stopped (exit code ${message.code}). The lines above are its output. Restart the simulator to run another kernel.`,
      },
      // The run id is cleared so a result message a dead module might still produce
      // is dropped rather than rendered. The WORKER is left in place: it has marked
      // itself crashed and refuses further work.
      { type: "end-run" },
    ];
  }
  return [
    { type: "set-telemetry", telemetry: message.telemetry },
    // The history is KEPT rather than cleared, and it is the only thing the Dashboard
    // renders: clearing it would empty the tab the moment the run ended, and the
    // series is the record of HOW the run got to its final numbers.
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
