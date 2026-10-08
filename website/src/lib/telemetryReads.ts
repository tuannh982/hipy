import type { LdsAnalysisData, OtlpMetricsData, TelemetryBundle } from "./protocol";
import { getNumberWasmFunction } from "./libcudart";

export function finalizeRun(exports: Record<string, WebAssembly.ExportValue>): { drained: number; error: string | null } {
  try {
    return { drained: getNumberWasmFunction(exports, "drain")(), error: null };
  } catch (error: unknown) {
    return { drained: 1, error: `drain failed: ${String(error)}` };
  }
}

const decoder = new TextDecoder();

export type ExportRead = {
  value: unknown | null;
  error?: string;
};

export type TelemetryRead = {
  telemetry: TelemetryBundle | null;
  errors: string[];
};

export function readExport(exports: Record<string, WebAssembly.ExportValue>, goRead: (ptr: number, length: number) => Uint8Array, name: "metrics" | "ldsAnalysis" | "dashboardSchema"): ExportRead {
  try {
    const length = getNumberWasmFunction(exports, name)();
    if (length <= 0) return { value: null, error: `${name} export returned no data` };
    const ptr = getNumberWasmFunction(exports, "resultPtr")();
    return { value: JSON.parse(decoder.decode(goRead(ptr, length))) };
  } catch (error: unknown) {
    return { value: null, error: `${name} export failed: ${String(error)}` };
  }
}

export function readExportError(
  exports: Record<string, WebAssembly.ExportValue>,
  goRead: (ptr: number, length: number) => Uint8Array,
): string | null {
  try {
    const length = getNumberWasmFunction(exports, "resultLen")();
    if (length <= 0) return null;
    const ptr = getNumberWasmFunction(exports, "resultPtr")();
    const text = decoder.decode(goRead(ptr, length)).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

export function readTelemetry(exports: Record<string, WebAssembly.ExportValue>, goRead: (ptr: number, length: number) => Uint8Array): TelemetryRead {
  const metricsRead = readExport(exports, goRead, "metrics");
  const ldsRead = readExport(exports, goRead, "ldsAnalysis");
  const metrics = metricsRead.value as OtlpMetricsData | null;
  const lds = ldsRead.value as LdsAnalysisData | null;
              const ldsExported = exports.ldsAnalysis != null;
  const errors = [metricsRead.error, ldsExported ? ldsRead.error : undefined].filter((error): error is string => error !== undefined);
  if (!metrics) return { telemetry: null, errors };
  return {
    telemetry: {
      metrics: metrics ?? { resourceMetrics: [] },
      lds: lds ?? { patterns: [], stats: { patterns: 0, droppedExecutions: 0, truncatedInstances: 0 } },
    },
    errors,
  };
}
