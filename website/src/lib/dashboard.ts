import { formatBytes, formatDurationNs } from "./format";
import type { ChartSchema, HierarchyRow, Metrics, ValueKind } from "./protocol";

const PS_PER_SECOND = 1e12;
const PS_PER_NS = 1e3;
const BYTES_PER_GB = 1e9;
const BYTES_PER_MIB = 1024 * 1024;

export function seriesTimes(samples: readonly Metrics[], kind: ValueKind): number[] {
  const times = samples.map((sample) => sample.simTimePs);
  return kind === "rate" ? times.slice(1) : times;
}

const DERIVED_PATHS: Record<string, (sample: Metrics) => number> = {
  elapsedSinceLaunchPs: (sample) => Math.max(0, sample.simTimePs - sample.launchSimTimePs),
};

export function readPath(sample: Metrics, path: string): number | undefined {
  const derived = DERIVED_PATHS[path];
  if (derived !== undefined) return derived(sample);
  let cursor: unknown = sample;
  for (const key of path.split(".")) {
    if (Array.isArray(cursor)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : undefined;
}

export function chartSeries(
  chart: ChartSchema,
  samples: readonly Metrics[],
  latest: Metrics,
): { values: (number | undefined)[][]; times: number[]; kernels: KernelSeries[] } {
  const times = seriesTimes(samples, chart.valueKind);
  const values = chart.series.map((series) => seriesValues(samples, series.path, chart.valueKind));
  const kernels = kernelSeries(chart, samples, latest);
  for (const entry of kernels) {
    values.push(entry.values[0], entry.values[1]);
  }
  return { values, times, kernels };
}

function kernelSeries(
  chart: ChartSchema,
  samples: readonly Metrics[],
  latest: Metrics,
): KernelSeries[] {
  const template = chart.kernelSeries;
  const kernels = latest.kernelTraffic ?? [];
  if (template === undefined || kernels.length === 0) return [];

  return kernels.map((entry, index) => ({
    kernel: entry.kernel,
    color: KERNEL_HUES[index % KERNEL_HUES.length],
    values: [
      seriesValues(samples, template.readPath.replace(/%d/g, String(index)), chart.valueKind),
      seriesValues(samples, template.writePath.replace(/%d/g, String(index)), chart.valueKind),
    ] as const,
  }));
}

const KERNEL_HUES: readonly string[] = [
  "#4ec9b0", // --chart-share
  "#dcdcaa", // --chart-memory
  "#f48771",
  "#9cdcfe",
  "#c586c0",
  "#ce9178",
];

export type KernelSeries = {
  kernel: string;
  color: string;
    values: readonly [(number | undefined)[], (number | undefined)[]];
};

export function seriesValues(
  samples: readonly Metrics[],
  path: string,
  kind: ValueKind,
): (number | undefined)[] {
  if (kind !== "rate") {
    return samples.map((sample) => {
      const value = readPath(sample, path);
      if (value === undefined) return undefined;
      return kind === "bytes" ? value / BYTES_PER_MIB : value;
    });
  }
  const values: (number | undefined)[] = [];
  for (let index = 1; index < samples.length; index++) {
    const now = readPath(samples[index], path);
    const before = readPath(samples[index - 1], path);
    const elapsedSeconds = (samples[index].simTimePs - samples[index - 1].simTimePs) / PS_PER_SECOND;
    if (
      now === undefined ||
      before === undefined ||
      elapsedSeconds <= 0 ||
      samples[index].launchSimTimePs !== samples[index - 1].launchSimTimePs
    ) {
      values.push(undefined);
      continue;
    }
    values.push(Math.max(0, now - before) / elapsedSeconds / BYTES_PER_GB);
  }
  return values;
}

export function yAxisFormat(kind: ValueKind): (value: number) => string {
  return kind === "bytes" ? (value) => value.toFixed(value < 10 ? 2 : 0) : (value) => value.toFixed(0);
}

export function renderNote(template: string, latest: Metrics): string {
  return template.replace(/\{([^}]+)\}/g, (token, expression: string) => formatToken(latest, expression, token));
}

function formatToken(latest: Metrics, expression: string, unresolvable: string): string {
  const separator = expression.indexOf(":");
  const path = expression.slice(0, separator === -1 ? undefined : separator);
  const value = readPath(latest, path);
  const format = separator === -1 ? "number" : expression.slice(separator + 1);
  // `memory` is the one format needing a second figure, named after a slash:
  // "used:memory/capacity".
  const slash = format.indexOf("/");
  const name = slash === -1 ? format : format.slice(0, slash);

  switch (name) {
    case "bytes":
      return value === undefined ? unresolvable : formatBytes(value);
    case "count":
      return value === undefined ? unresolvable : value.toLocaleString("en-US");
    case "percent":
      return value === undefined ? unresolvable : `${Math.round(value * 100)}%`;
    case "memory": {
      const capacity = slash === -1 ? undefined : readPath(latest, format.slice(slash + 1));
      if (value === undefined || capacity === undefined) return unresolvable;
      // "15.00 MiB of 16.00 MiB (94%)" says how close to the limit a reader is.
      return `${formatBytes(value)} of ${formatBytes(capacity)} (${Math.round((value / capacity) * 100)}%)`;
    }
    case "duration":
      return value === undefined ? unresolvable : formatDurationNs(value / PS_PER_NS);
    case "number":
      return value === undefined ? unresolvable : String(value);
    default:
      return unresolvable;
  }
}

export type ResolvedHierarchyRow = HierarchyRow & {
  readBytes: number;
  writeBytes: number;
    present: boolean;
};

export function hierarchyRows(rows: readonly HierarchyRow[], latest: Metrics): ResolvedHierarchyRow[] {
  return rows.map((row) => {
    const readBytes = readPath(latest, row.readPath);
    const writeBytes = readPath(latest, row.writePath);
    return {
      ...row,
      readBytes: readBytes ?? 0,
      writeBytes: writeBytes ?? 0,
      present: readBytes !== undefined || writeBytes !== undefined,
    };
  });
}

export function meterValue(path: string, latest: Metrics): number | undefined {
  return readPath(latest, path);
}

export function shouldWarn(chart: ChartSchema, latest: Metrics): boolean {
  if (chart.warn === undefined) return false;
  const value = readPath(latest, chart.warn.path);
  const capacity = readPath(latest, chart.warn.capacityPath);
  if (value === undefined || capacity === undefined || capacity <= 0) return false;
  return value / capacity >= chart.warn.atLeast;
}

export function referenceLine(
  chart: ChartSchema,
  latest: Metrics,
): { value: number; label: string } | null {
  if (chart.reference === undefined) return null;
  const value = readPath(latest, chart.reference.path);
  if (value === undefined) return null;
  return { value, label: `${value.toLocaleString("en-US")} ${chart.reference.label}` };
}
