import { TimeSeries } from "./charts/Series";
import type { Series as ChartSeries } from "./charts/Series";
import { formatBytes, formatHitRate } from "../lib/format";
import {
  chartSeries,
  hierarchyRows,
  meterValue,
  referenceLine,
  renderNote,
  shouldWarn,
  yAxisFormat,
} from "../lib/dashboard";
import type { ResolvedHierarchyRow } from "../lib/dashboard";
import type {
  ChartSchema,
  MeterEntry,
  Metrics,
  DashboardSchema,
  SeriesSchema,
} from "../lib/protocol";

type LiveDashboardProps = {
  /** The sample history, oldest first. */
  samples: readonly Metrics[];
  /**
   * How the device says to draw the stream, off the simulator's dashboardSchema
   * export for this run's platform. Required: every heading, unit and row here is a
   * device fact, so a hardcoded fallback would be guessing about hardware in the
   * wrong layer. No schema means no dashboard.
   */
  schema: DashboardSchema;
  /** True while a run is in flight, which is what separates "live" from "final". */
  running: boolean;
};

// The four hues, mirroring the --chart-* tokens in styles.css. Spelled out rather
// than read from the tokens because an SVG presentation attribute cannot take a
// custom property, so a hue change is two edits and the two live side by side.
//
// The schema names which one a series means; what it looks like is this file's.
const HUES: Record<string, string> = {
  read: "#38bdf8", // --chart-read
  write: "#a78bfa", // --chart-write
  // Occupancy and memory are deliberately NOT the two traffic hues: read and write
  // are opposites a reader must tell apart, and these never appear beside one another.
  share: "#4ec9b0", // --chart-share
  memory: "#dcdcaa", // --chart-memory
};

/** The hue for a name the schema used, falling back to the share hue. */
function hueColor(hue: string): string {
  return HUES[hue] ?? HUES.share;
}

/**
 * The live readout: what the GPU is doing while it is doing it.
 *
 * The panel renders the schema and nothing else. Which cache levels the device
 * built, how many lanes it has and what the headings say were all decided in
 * harness/dashboard.go, off the platform it actually built. What is left here is
 * presentation.
 */
export function LiveDashboard({ samples, schema, running }: LiveDashboardProps) {
  const latest = samples[samples.length - 1];
  if (latest === undefined) return null;

  return (
    <section className="report-section live-panel" aria-label={schema.title}>
      <div className="section-title">
        <div>
          <span className="eyebrow">{running ? schema.runningEyebrow : schema.finalEyebrow}</span>
          <h2>{schema.title}</h2>
        </div>
        <span className={running ? "live-badge on" : "live-badge"}>
          {running ? schema.runningBadge : schema.finalBadge} · {renderNote(schema.badge, latest)}
        </span>
      </div>

      <MemHierarchyStrip schema={schema} rows={hierarchyRows(schema.hierarchy.rows, latest)} />

      {renderCharts(schema.charts, samples, latest)}

      <div className="section-title">
        <div>
          <span className="eyebrow">{schema.meters.eyebrow}</span>
          <h2>{schema.meters.title}</h2>
        </div>
        <span className="muted">{schema.meters.note}</span>
      </div>
      <div className="rate-grid">
        {schema.meters.entries.map((entry) => (
          <Meter entry={entry} latest={latest} key={entry.label} />
        ))}
      </div>
      <p className="table-note">{renderNote(schema.footer, latest)}</p>
    </section>
  );
}

/**
 * The charts, in schema order, with the paired ones sharing a row. Pairing is the
 * schema's decision rather than a matter of position, so which charts belong
 * together is a statement about the device. A `pair` whose partner is missing is
 * drawn full-width rather than dropped.
 */
function renderCharts(
  charts: readonly ChartSchema[],
  samples: readonly Metrics[],
  latest: Metrics,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let pending: ChartSchema[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const [first] = pending;
    const drawn = pending.map((chart) => (
      <Chart chart={chart} samples={samples} latest={latest} key={chart.id} />
    ));
    nodes.push(
      pending.length === 1 ? drawn[0] : <div className="chart-pair" key={`pair-${first.id}`}>{drawn}</div>,
    );
    pending = [];
  };

  for (const chart of charts) {
    if (chart.layout !== "pair") {
      flush();
      nodes.push(<Chart chart={chart} samples={samples} latest={latest} key={chart.id} />);
      continue;
    }
    pending.push(chart);
    if (pending.length === 2) flush();
  }
  flush();
  return nodes;
}

/**
 * A heading and a chart, which is the shape every plot on this panel takes. The
 * readout lives in the heading because a y axis carries a scale and not a current
 * value; the device writes the heading as a template over the sample.
 *
 * A traffic chart also carries one series per kernel, cumulative, so each plots as a
 * hill: nothing before its first launch, rising while it runs, flat after.
 */
function Chart({
  chart,
  samples,
  latest,
}: {
  chart: ChartSchema;
  samples: readonly Metrics[];
  latest: Metrics;
}) {
  const { values, times, kernels } = chartSeries(chart, samples, latest);
  const series = chart.series.map((entry: SeriesSchema, index: number) => ({
    id: entry.id,
    label: entry.label,
    color: hueColor(entry.hue),
    values: values[index],
  })) as ChartSeries[];
  // Hue per kernel, dash per direction.
  for (const entry of kernels) {
    series.push(
      { id: `kernel-${entry.kernel}-read`, label: `${entry.kernel} reads`, color: entry.color, values: entry.values[0] },
      { id: `kernel-${entry.kernel}-write`, label: `${entry.kernel} writes`, color: entry.color, values: entry.values[1], dashed: true },
    );
  }
  const reference = referenceLine(chart, latest);

  return (
    <div className="chart-block">
      <div className="chart-heading">
        <div>
          <span className="eyebrow">{chart.eyebrow}</span>
          <strong>{chart.title}</strong>
        </div>
        <span className={shouldWarn(chart, latest) ? "muted warn" : "muted"}>
          {chart.note === undefined ? "" : renderNote(chart.note, latest)}
        </span>
      </div>
      <TimeSeries
        series={series}
        times={times}
        yAxisLabel={chart.yUnit}
        xAxisTitle={chart.xUnit}
        formatY={yAxisFormat(chart.valueKind)}
        reference={reference ?? undefined}
        ariaLabel={describe(chart, series, times.length)}
        emptyMessage={chart.empty ?? "No samples yet."}
      />
    </div>
  );
}

/**
 * The chart's accessible name, since the axis labels alone are not a description.
 * Composed from the schema rather than written per chart, so it cannot disagree
 * with what is drawn.
 */
function describe(chart: ChartSchema, series: readonly ChartSeries[], points: number): string {
  const names = series.map((entry) => entry.label).join(" and ");
  const noun = chart.valueKind === "rate" ? "intervals" : "samples";
  return `${chart.title}: ${names} across ${points} ${noun} of ${chart.xUnit}, in ${chart.yUnit}.`;
}

/**
 * A hit rate as a figure and a proportional bar. A bar rather than a chart because a
 * hit rate converges on one value and has no shape over time to draw.
 */
function Meter({ entry, latest }: { entry: MeterEntry; latest: Metrics }) {
  const rate = meterValue(entry.path, latest);
  // Absent rather than zero: a level with no traffic gets no meter at all.
  if (rate === undefined) return null;
  const percent = Math.max(0, Math.min(1, rate));
  return (
    <div className="rate">
      <div className="rate-head">
        <span>{entry.label}</span>
        <span className="rate-value">{formatHitRate(rate)}</span>
      </div>
      <div className="rate-track" role="meter" aria-label={`${entry.label} hit rate`} aria-valuenow={Math.round(percent * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="rate-fill" style={{ width: `${percent * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * The memory hierarchy, as rows from the innermost level outward to DRAM. A row the
 * sample says nothing about is drawn "not present", since a zero would be a claim
 * about traffic and the truth is about hardware.
 */
function MemHierarchyStrip({ schema, rows }: { schema: DashboardSchema; rows: readonly ResolvedHierarchyRow[] }) {
  return (
    <div className="mem-hierarchy">
      <div className="mem-hierarchy-head">
        <span className="eyebrow">{schema.hierarchy.eyebrow}</span>
        <span className="table-note-inline">{schema.hierarchy.note}</span>
      </div>
      <ul className="mem-hierarchy-rows">
        {rows.map((row) => (
          <li key={row.label} className={row.present ? "mem-row" : "mem-row absent"}>
            <span className="mem-level">{row.label}</span>
            <span className="mem-bytes read" title="bytes read at this level">
              {row.present ? formatBytes(row.readBytes) : "not present"}
            </span>
            <span className="mem-bytes write" title="bytes written at this level">
              {row.present ? formatBytes(row.writeBytes) : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}