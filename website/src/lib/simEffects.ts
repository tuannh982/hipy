// Applying what routeSimMessage decided.
//
// The split is deliberate. lib/simMessages.ts answers "what does this message mean",
// purely and without React, so it can be asserted in a test; this file answers "what
// does the page do about it", which is unavoidably setState. A routing mistake shows
// up as a missing entry in a returned array, and a missed effect here is a COMPILE
// error, because the switch at the bottom assigns its unhandled case to `never`.

import type { SimEffect, SimStage, SimStatus, SimTab, ConsoleKind } from "./simMessages";
import type { CatalogDevice, CatalogBody } from "./catalog";
import type { Metrics, DashboardSchema, TelemetryBundle } from "./protocol";

/**
 * How many samples are held: roughly six seconds of kernel at the harness's 40ms
 * flush. The OLDEST are dropped rather than new samples refused, because the panel's
 * y axis is scaled to the window it holds -- dropping the newest would freeze the
 * readouts at the moment the buffer filled.
 */
export const METRICS_LIMIT = 160;

export type SimEffectHandlers = {
  setCatalog: (body: CatalogBody) => void;
  setCatalogError: (error: string | null) => void;
  setSimStatus: (status: SimStatus) => void;
  setDevice: (name: string) => void;
  setStage: (stage: SimStage) => void;
  setActiveTab: (tab: SimTab) => void;
  appendConsole: (kind: ConsoleKind, text: string) => void;
  appendMetrics: (metrics: Metrics) => void;
  /**
   * How the stream should be drawn, for the run that is about to stream. Cleared by
   * clearMetrics like the samples: a schema that outlives its run would draw the next
   * run's samples against the previous device's levels and units.
   */
  setDashboard: (schema: DashboardSchema | null) => void;
  /**
   * The previous run's numbers are gone. Clears the samples, the schema and the
   * telemetry; App.tsx also clears the device they were measured on.
   */
  clearMetrics: () => void;
  setTelemetry: (telemetry: TelemetryBundle | null) => void;
  setPartialTelemetry: (value: boolean) => void;
  setConfiguring: (value: boolean) => void;
  /** Resolves the readiness promise a run waits on before posting its request. */
  resolveReady: () => void;
  /** Reports a finished run's elapsed time; the caller owns the clock. */
  onRunComplete: () => void;
  /** The run a message belonged to is over: clear the run id. */
  endRun: () => void;
};

/**
 * Carry out a route's effects in the order the router emitted them. `end-run` is
 * emitted LAST by all three terminal routes in simMessages.ts, and so runs last
 * here: the run id is cleared only after the message's visible effects have been
 * applied.
 */
export function applySimEffects(effects: readonly SimEffect[], handlers: SimEffectHandlers): void {
  for (const effect of effects) applySimEffect(effect, handlers);
}

function applySimEffect(effect: SimEffect, handlers: SimEffectHandlers): void {
  switch (effect.type) {
    case "set-catalog":
      handlers.setCatalog(effect.body);
      return;
    case "set-catalog-error":
      handlers.setCatalogError(effect.error);
      return;
    case "clear-catalog-error":
      handlers.setCatalogError(null);
      return;
    case "set-sim-status":
      handlers.setSimStatus(effect.status);
      return;
    // Only ever a fallback: a device the reader has already chosen is theirs, and a
    // catalog arriving late must not move the select out from under them.
    case "set-default-device":
      handlers.setDevice(effect.name);
      return;
    case "resolve-ready":
      handlers.resolveReady();
      return;
    case "append-console":
      handlers.appendConsole(effect.kind, effect.text);
      return;
    case "set-stage":
      handlers.setStage(effect.stage);
      return;
    case "set-tab":
      handlers.setActiveTab(effect.tab);
      return;
    case "append-metrics":
      handlers.appendMetrics(effect.metrics);
      return;
    case "set-dashboard":
      handlers.setDashboard(effect.schema);
      return;
    case "clear-metrics":
      handlers.clearMetrics();
      return;
    case "set-telemetry":
      handlers.setTelemetry(effect.telemetry);
      return;
    case "set-partial-telemetry":
      handlers.setPartialTelemetry(effect.value);
      return;
    case "set-configuring":
      handlers.setConfiguring(effect.value);
      return;
    case "announce-run-complete":
      handlers.onRunComplete();
      return;
    case "end-run":
      handlers.endRun();
      return;
    default: {
      // A router that can return an effect nobody applied is a silent no-op, and
      // this is what makes it a compile error instead. routeSimMessage gets the
      // same check from its `result` fallthrough; a switch has none, so it needs
      // this one.
      const unhandled: never = effect;
      void unhandled;
    }
  }
}

/** Re-exported so App.tsx's single import reaches both halves of the pair. */
export type { SimEffect, SimStage, SimStatus, SimTab, ConsoleKind };
export type { CatalogDevice };
