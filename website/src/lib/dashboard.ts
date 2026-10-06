import { formatBytes, formatDurationNs } from "./format";
import type { ChartSchema, HierarchyRow, Metrics, ValueKind } from "./protocol";

// Turning the device's schema and its sample stream into what the charts need. The
// schema says WHAT to draw -- a title, a unit, the sample path each line comes from
// -- and this file is the one place that knows HOW.
//
// Two things make that split worth having. Every sample is cumulative, so a rate is
// a difference between two of them over the difference in the engine clock, never a
// field on one. And the paths are DATA, not typed fields: the hierarchy's traffic
// lives in a map keyed by the device's own cache levels, so
// "memLevels.L2.readSinceLaunchBytes" is a string the schema supplies and this file
// walks. A path that resolves to nothing is a gap, never a zero.

const PS_PER_SECOND = 1e12;
const PS_PER_NS = 1e3;
const BYTES_PER_GB = 1e9;
const BYTES_PER_MIB = 1024 * 1024;

/**
 * The simulated time each point sits at, for a chart of this kind. A function of the
 * value kind rather than something each caller slices, so a rate chart cannot be
 * paired with the samples' own times.
 */
export function seriesTimes(samples: readonly Metrics[], kind: ValueKind): number[] {
  const times = samples.map((sample) => sample.simTimePs);
  return kind === "rate" ? times.slice(1) : times;
}

/**
 * Figures that are not FIELDS on a sample, keyed by the same dot-path syntax and
 * resolved first, so a schema may name either.
 *
 * elapsedSinceLaunchPs is the engine clock minus the clock at the launch: the H2D
 * copies preceding every launch tick the engine, so the raw clock reads high before
 * the kernel has done anything. A negative result would mean the clock went
 * backwards, which cannot happen from the simulator, and is floored at zero.
 */
const DERIVED_PATHS: Record<string, (sample: Metrics) => number> = {
  elapsedSinceLaunchPs: (sample) => Math.max(0, sample.simTimePs - sample.launchSimTimePs),
};

/**
 * Read a dot-separated path out of a sample, or one of the derived figures.
 * Undefined for anything that is not a finite number at the end of the path, which
 * covers a level the device does not have and an object that is missing. Callers
 * decide what an absent figure means.
 *
 * A numeric segment indexes an ARRAY. That is how a kernel's entry is reached: the
 * schema is read before any kernel has run, so it cannot name them and hands the
 * panel a template with the index left in.
 */
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

/**
 * One chart's lines in the units its y axis is labelled in, plus the time axis they
 * are drawn against. The times come back with the values rather than being asked
 * for separately, so a caller cannot pair a rate's values with a value chart's axis.
 */
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

/** One kernel's read and write series, from the newest sample's kernel list. */
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

// Hue per kernel, cycled. Direction is the dash rather than a hue precisely because a
// hue may repeat: a repeated hue is ambiguous about which kernel, a dash is only ever
// read or write. These are the hues the panel does not already spend on read/write.
const KERNEL_HUES: readonly string[] = [
  "#4ec9b0", // --chart-share
  "#dcdcaa", // --chart-memory
  "#f48771",
  "#9cdcfe",
  "#c586c0",
  "#ce9178",
];

/** One kernel's pair of series on one chart. */
export type KernelSeries = {
  kernel: string;
  color: string;
  /** [reads, writes], in the units the chart's y axis is labelled in. */
  values: readonly [(number | undefined)[], (number | undefined)[]];
};

/**
 * One series' values over the whole history. A `rate` series is consecutive samples
 * differenced over the simulated seconds between them, floored at zero, and
 * undefined where the difference cannot be computed: one sample describes no
 * interval, and a zero there would draw a flat line that reads as an idle GPU.
 */
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
    if (now === undefined || before === undefined || elapsedSeconds <= 0) {
      values.push(undefined);
      continue;
    }
    values.push(Math.max(0, now - before) / elapsedSeconds / BYTES_PER_GB);
  }
  return values;
}

/**
 * A chart's y-axis tick formatter. Bytes get two decimals below 10 and none above,
 * which is the range where the difference between two ticks is visible at all.
 */
export function yAxisFormat(kind: ValueKind): (value: number) => string {
  return kind === "bytes" ? (value) => value.toFixed(value < 10 ? 2 : 0) : (value) => value.toFixed(0);
}

/**
 * Fill a note template from the newest sample. A token is `{path}` or
 * `{path:format}`, where format is one of the names below and a `memory` token
 * takes a second path after a slash. Anything else is literal text, which is why a
 * device can write a sentence here instead of the panel composing one.
 *
 * An unknown format or an unresolvable path renders the token's own text rather
 * than throwing: a schema from a different simulator must cost one ugly heading,
 * not a blank panel.
 */
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

/** One hierarchy row resolved against a sample, ready to render. */
export type ResolvedHierarchyRow = HierarchyRow & {
  readBytes: number;
  writeBytes: number;
  /** False when the device has no such level, which is drawn differently. */
  present: boolean;
};

/**
 * The memory hierarchy as rows, with each row's figures read off the newest sample.
 * A row the sample says nothing about is `present: false` rather than zeros, because
 * "the device has no MALL" and "the MALL has seen no traffic" are different claims.
 */
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

/**
 * One meter, and whether the sample has a figure for it at all. A level with no
 * traffic is absent from the grid rather than zero, so it is absent here too.
 */
export function meterValue(path: string, latest: Metrics): number | undefined {
  return readPath(latest, path);
}

/** Whether a chart's warning condition holds for the newest sample. */
export function shouldWarn(chart: ChartSchema, latest: Metrics): boolean {
  if (chart.warn === undefined) return false;
  const value = readPath(latest, chart.warn.path);
  const capacity = readPath(latest, chart.warn.capacityPath);
  if (value === undefined || capacity === undefined || capacity <= 0) return false;
  return value / capacity >= chart.warn.atLeast;
}

/**
 * The reference line for a chart, read off the newest sample so it cannot drift from
 * the axis it is drawn against. Null when the sample cannot say what the ceiling is.
 */
export function referenceLine(
  chart: ChartSchema,
  latest: Metrics,
): { value: number; label: string } | null {
  if (chart.reference === undefined) return null;
  const value = readPath(latest, chart.reference.path);
  if (value === undefined) return null;
  return { value, label: `${value.toLocaleString("en-US")} ${chart.reference.label}` };
}

