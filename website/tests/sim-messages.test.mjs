// Which simulator message reaches which handler, and which is dropped.
//
// Routing lives here, not in a React component, so that "which messages does this app
// answer, and in what state" is asserted rather than left to inspection.
//
// The dispatcher is PURE. It takes the state the routing depends on and returns a
// list of effects; it mutates nothing and imports no React. App.tsx applies the
// effects. That is what makes a dropped message visible as a MISSING effect in a
// returned array rather than as an absence nobody can assert on.
//
// Two rules the routing follows, and they are why the run-id gate exists at all:
//
//   1. A message belonging to a run is dropped unless its run id is the current
//      one. A superseded run's output must not land on the current run's screen:
//      a chart drawn from two runs is an artifact no reader can tell from real
//      behaviour. That is what simRunRef is for.
//   2. A message that is NOT about a run is never subject to that gate. It has no
//      run id to match, so gating it on one drops it unconditionally. `catalog`,
//      `ready` and `configured` are all in this class.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const { routeSimMessage } = await tsImport(
  path.join(repoRoot, "website", "src", "lib", "simMessages.ts"),
  import.meta.url,
);

// A catalog body carrying the one figure a select needs: a device list that
// actually contains the device it names as its default. defaultDevice answers
// null for a default the body does not list, which is the case the router has to
// refuse rather than select.
const body = {
  defaultDevice: "gcn3generic",
  devices: [{ name: "gcn3generic", label: "AMD GCN3 Generic", vramBytes: 16 * 1024 * 1024 }],
};

/** Between runs, which is the state a configuration save is always in. */
const idle = { runId: null, currentRunId: 3 };
/** Mid-run: run 3 is the one the page is watching. */
const inRun = { runId: 3, currentRunId: 3 };
/** After the page moved on to run 4; run 3's messages are stale. */
const superseded = { runId: 3, currentRunId: 4 };

const kinds = (effects) => effects.map((effect) => effect.type);

test("a save's answer clears the saving state when no run is in flight", () => {
  // A save posts `configure` and never assigns a run id -- only run() does -- so
  // runId is null here and the message must bypass the run-id gate.
  const effects = routeSimMessage({ type: "configured", body }, idle);
  assert.ok(
    effects.some((effect) => effect.type === "set-configuring" && effect.value === false),
    `expected a set-configuring(false) effect, got ${JSON.stringify(effects)}`,
  );
});

test("a successful save replaces the catalog and clears the previous run's metrics", () => {
  // The figures on screen have to be the ones the next run will build.
  const effects = routeSimMessage({ type: "configured", body }, idle);
  assert.deepEqual(kinds(effects), [
    "set-catalog",
    "clear-catalog-error",
    "set-sim-status",
    "clear-metrics",
    "set-partial-telemetry",
    "append-console",
    "set-configuring",
  ]);
  assert.deepEqual(effects.find((effect) => effect.type === "set-catalog"), {
    type: "set-catalog",
    body,
  });
});

test("a refused save still clears the saving state and says why on the console", () => {
  // The panel keeps the values it had, so the reason belongs in the console rather
  // than beside a field the reader did not change.
  const effects = routeSimMessage(
    { type: "configured", body: null, error: "L2 of 4096 B is below the 65536 B minimum" },
    idle,
  );
  assert.deepEqual(kinds(effects), ["append-console", "set-configuring"]);
  assert.deepEqual(effects[0], {
    type: "append-console",
    kind: "stderr",
    text: "Configuration not saved: L2 of 4096 B is below the 65536 B minimum",
  });
});

test("a save's answer is routed even while a run is in flight", () => {
  // Defensive rather than reachable: the page disables the button mid-run. If the
  // two ever disagree the reader gets a cleared button rather than a stuck one.
  assert.ok(kinds(routeSimMessage({ type: "configured", body }, inRun)).includes("set-configuring"));
});

test("the startup catalog answers with no run in flight and marks the module alive", () => {
  const effects = routeSimMessage({ type: "catalog", body }, idle);
  assert.deepEqual(kinds(effects), [
    "set-catalog",
    "clear-catalog-error",
    "set-sim-status",
    "set-default-device",
  ]);
  assert.deepEqual(effects.at(-1), { type: "set-default-device", name: "gcn3generic" });
});

test("a catalog naming a default it does not list selects nothing", () => {
  // defaultDevice answers null for a default the body does not list, and a select
  // sitting on a device nothing can render is a state the page refuses to produce.
  const orphan = { defaultDevice: "v100", devices: body.devices };
  assert.ok(!kinds(routeSimMessage({ type: "catalog", body: orphan }, idle)).includes("set-default-device"));
});

test("a failed catalog read reports the reason and keeps the body already in hand", () => {
  // Blanking the select because a re-read was refused would replace a device list
  // that is still the simulator's own with an empty one.
  const effects = routeSimMessage({ type: "catalog", body: null, error: "a run is in progress" }, idle);
  assert.deepEqual(effects, [{ type: "set-catalog-error", error: "a run is in progress" }]);
});

test("ready resolves the readiness promise, which the page load is waiting on", () => {
  assert.deepEqual(routeSimMessage({ type: "ready" }, idle), [{ type: "resolve-ready" }]);
});

test("a run's own messages are routed while it is the current run", () => {
  assert.deepEqual(routeSimMessage({ type: "stdout", text: "hello" }, inRun), [
    { type: "append-console", kind: "stdout", text: "hello" },
  ]);
});

test("a superseded run's messages are dropped rather than drawn on this run", () => {
  // The reason the gate exists. Two runs' samples on one chart is the one artifact
  // a reader cannot tell from real behaviour.
  assert.deepEqual(routeSimMessage({ type: "stdout", text: "stale" }, superseded), []);
  assert.deepEqual(routeSimMessage({ type: "metrics", live: { simTimePs: 1 } }, superseded), []);
});

test("a crash marks the module dead and sends the reader to the explanation", () => {
  const effects = routeSimMessage({ type: "crash", code: 2 }, inRun);
  assert.deepEqual(kinds(effects), ["set-stage", "set-tab", "set-sim-status", "append-console", "end-run"]);
  assert.deepEqual(effects.find((effect) => effect.type === "set-sim-status"), {
    type: "set-sim-status",
    status: "crashed",
  });
});

test("the three messages that end a run say so, and the ones mid-run do not", () => {
  // Only the router knows which messages end a run. `live` arrives many times
  // during one and must not end it -- clearing the run id there would drop every
  // sample after the first.
  assert.ok(kinds(routeSimMessage({ type: "crash", code: 1 }, inRun)).includes("end-run"));
  assert.ok(kinds(routeSimMessage({ type: "error", message: "boom" }, inRun)).includes("end-run"));
  assert.ok(kinds(routeSimMessage({ type: "result", telemetry: { lds: {} } }, inRun)).includes("end-run"));
  for (const message of [
    { type: "stdout", text: "x" },
    { type: "metrics", live: { simTimePs: 1 } },
    { type: "simulator-output", kind: "stdout", text: "x" },
  ]) {
    assert.ok(!kinds(routeSimMessage(message, inRun)).includes("end-run"), `${message.type} must not end a run`);
  }
});

test("a save does not end a run -- it is not one", () => {
  // The two are independent: a page can save between runs, and a save while a run
  // is live is refused by the button rather than by ending the run.
  assert.ok(!kinds(routeSimMessage({ type: "configured", body }, inRun)).includes("end-run"));
});

test("a failed run that still returned telemetry marks the partial tabs", () => {
  // readTelemetry degrades a missing ldsAnalysis export to an empty analysis rather
  // than failing the run, so the LDS tab has as much partial data as Dashboard.
  const effects = routeSimMessage({ type: "error", message: "boom", telemetry: { lds: {} } }, inRun);
  assert.ok(kinds(effects).includes("set-partial-telemetry"));
  assert.ok(kinds(effects).includes("set-stage"));
});

test("a failed run with no telemetry is not marked partial", () => {
  const effects = routeSimMessage({ type: "error", message: "boom" }, inRun);
  assert.ok(!kinds(effects).includes("set-partial-telemetry"));
});

test("the simulator's own output is separated from the compiled program's", () => {
  // The fd is the only thing telling a panic from ordinary output.
  assert.deepEqual(routeSimMessage({ type: "simulator-output", kind: "stderr", text: "panic" }, inRun), [
    { type: "append-console", kind: "stderr", text: "panic" },
  ]);
});

test("a run's schema is routed, and one from a superseded run is dropped", () => {
  // It describes the platform the run was configured for, so it is gated exactly
  // like `live`: a stale schema would draw this run's samples against another
  // device's rows and units. It does NOT clear the samples -- it arrives just before
  // them, and clearing here would empty the panel for a frame.
  const schema = { title: "Live GPU metrics", charts: [] };
  assert.deepEqual(routeSimMessage({ type: "dashboard-schema", schema }, inRun), [
    { type: "set-dashboard", schema },
  ]);
  assert.deepEqual(routeSimMessage({ type: "dashboard-schema", schema }, superseded), []);
  assert.ok(!kinds(routeSimMessage({ type: "dashboard-schema", schema }, inRun)).includes("end-run"));
});

test("a completed run sets the telemetry and keeps the live series", () => {
  // No clear-metrics effect: the Dashboard renders the live history, and clearing
  // it would empty the tab the moment the run ended.
  const effects = routeSimMessage({ type: "result", telemetry: { lds: {} } }, inRun);
  assert.ok(kinds(effects).includes("set-telemetry"));
  assert.ok(!kinds(effects).includes("clear-metrics"));
});
