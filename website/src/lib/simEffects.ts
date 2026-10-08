
import type { SimEffect, SimStage, SimStatus, SimTab, ConsoleKind } from "./simMessages";
import type { CatalogDevice, CatalogBody } from "./catalog";
import type { Metrics, DashboardSchema, TelemetryBundle } from "./protocol";

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
    setDashboard: (schema: DashboardSchema | null) => void;
    clearMetrics: () => void;
  setTelemetry: (telemetry: TelemetryBundle | null) => void;
  setPartialTelemetry: (value: boolean) => void;
  setConfiguring: (value: boolean) => void;
    resolveReady: () => void;
    onRunComplete: () => void;
    endRun: () => void;
};

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
                              const unhandled: never = effect;
      void unhandled;
    }
  }
}

export type { SimEffect, SimStage, SimStatus, SimTab, ConsoleKind };
export type { CatalogDevice };
