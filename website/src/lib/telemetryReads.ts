import type { LdsAnalysisData, OtlpMetricsData, TelemetryBundle } from "./protocol";
import { getNumberWasmFunction } from "./libcudart";

/**
 * Finish the run, once the program's `main()` has returned.
 *
 * This has to happen here rather than being left to the program's own
 * `cudaDeviceSynchronize`, for two reasons that both cost a reader a wrong number.
 *
 * The simulator's live stream is driven by retired instructions, so it stops
 * sampling the moment the last kernel finishes. A `cudaDeviceSynchronize` in the
 * middle of `main` therefore produces the LAST live sample of the run -- anything
 * the host does after it is invisible to the panel. Device memory is the clearest
 * case: a program that allocates or frees after its final synchronize leaves the
 * Device-memory meter showing the state at that synchronize, so a later
 * `cudaFree` never appears to take effect and a later `cudaMalloc` never appears
 * at all.
 *
 * And `drain` is also what emits the final sample at all (`EmitLiveFinal`), so
 * without this call the last point on every chart is whichever paced sample
 * happened to be last rather than the end of the run.
 *
 * `drain` also waits out anything the program left queued. A program that returns
 * without synchronizing gets its work run here rather than silently missing from
 * the telemetry read below, bounded by the instruction budget, and `drained` says
 * so when the budget is what stopped it.
 *
 * Returns the export's own answer: 0 for a completed run, 1 when the instruction
 * budget stopped it.
 */
export function finalizeRun(exports: Record<string, WebAssembly.ExportValue>): { drained: number; error: string | null } {
  try {
    return { drained: getNumberWasmFunction(exports, "drain")(), error: null };
  } catch (error: unknown) {
    return { drained: 1, error: `drain failed: ${String(error)}` };
  }
}

// The two telemetry body reads, lifted out of sim.worker.ts so they are reachable
// from the test suite. Both functions are pure: they take the exports object and the
// Go read helper as arguments and touch no worker scope, no import.meta.env and no
// module state beyond this decoder.
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

// Every wasmexport returns 0 on success and 1 on failure with the reason in the
// shared result buffer, so a bare "configure failed" names the export and nothing
// else. This is the only place that reason is read: the Go boundary writes messages
// a user can act on ('unknown device "v100"; known devices: r9nano', wasmexec/
// exports.go). Null when the export left no text.
//
// No name argument: every export shares one result buffer, so the caller names its
// own step in the message it composes from this.
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

// Every body is read here, after main() has returned, so no LaunchKernel is left
// out of the LDS drain. The analysis body is the read that arms it, so calling this
// between launches would silently drop everything after that point.
export function readTelemetry(exports: Record<string, WebAssembly.ExportValue>, goRead: (ptr: number, length: number) => Uint8Array): TelemetryRead {
  const metricsRead = readExport(exports, goRead, "metrics");
  const ldsRead = readExport(exports, goRead, "ldsAnalysis");
  const metrics = metricsRead.value as OtlpMetricsData | null;
  const lds = ldsRead.value as LdsAnalysisData | null;
  // Whether the analysis error is collected depends on WHY the read failed, and the
  // export's presence is what distinguishes the two cases: a sim-runner.wasm that
  // predates the ldsAnalysis export must degrade to the empty default below -- a
  // working dashboard and an LDS tab that reports no LDS -- rather than report a
  // broken run. A build that does export it and still cannot produce a readable body
  // is a different fault, so the error is collected.
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
