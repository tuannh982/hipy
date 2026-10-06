import type { CatalogBody } from "./catalog";

export type OtlpAggregationTemporality =
  | "AGGREGATION_TEMPORALITY_UNSPECIFIED"
  | "AGGREGATION_TEMPORALITY_DELTA"
  | "AGGREGATION_TEMPORALITY_CUMULATIVE"
  | number;

export type OtlpInt64 = number | string;

export type OtlpAnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: OtlpInt64;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
};

export type OtlpKeyValue = {
  key: string;
  value?: OtlpAnyValue;
};

export type OtlpResource = {
  attributes?: OtlpKeyValue[];
};

export type OtlpInstrumentationScope = {
  name?: string;
  version?: string;
  attributes?: OtlpKeyValue[];
};

export type OtlpNumberDataPoint = {
  attributes?: OtlpKeyValue[];
  startTimeUnixNano?: OtlpInt64;
  timeUnixNano?: OtlpInt64;
  asDouble?: number;
  asInt?: OtlpInt64;
  flags?: number;
};

export type OtlpMetricData = {
  dataPoints?: OtlpNumberDataPoint[];
};

export type OtlpMetric = {
  name: string;
  unit?: string;
  description?: string;
  gauge?: OtlpMetricData;
  sum?: OtlpMetricData & {
    aggregationTemporality?: OtlpAggregationTemporality;
    isMonotonic?: boolean;
  };
};

export type OtlpScopeMetrics = {
  scope?: OtlpInstrumentationScope;
  metrics?: OtlpMetric[];
};

export type OtlpResourceMetrics = {
  resource?: OtlpResource;
  scopeMetrics?: OtlpScopeMetrics[];
};

export type OtlpMetricsData = {
  resourceMetrics?: OtlpResourceMetrics[];
};

// lanes is nullable on the wire and honestly so: the Go conversion in
// internal/ldsanalysis/drain.go assigns ph.Lanes
// straight from the analyzer, which only appends an active lane, so a phase whose
// whole lane range is inactive is never appended to and marshals as null. The Go
// field is []int, which has no null, so this is Go's slice edge case, not a
// deliberate value. normalize turns it into [].
//
// bankAddrs is how many DISTINCT addresses each bank saw in this phase, indexed
// by bank, and it is the number the bank map is drawn from: a bank is conflicted
// in a phase when its entry is greater than 1. It is a fixed 32-entry array
// upstream (a Go [32]int marshals as an array, never null), and most entries are
// 0 or 1. It is typed nullable because a body from before the field existed
// simply has none, which normalize turns into all zeros rather than a crash.
export type LdsPhaseData = {
  firstLane: number;
  lastLane: number;
  lanes: number[] | null;
  degree: number;
  bankAddrs: number[] | null;
};
// phase is -1 for an active lane that matches no phase's lane range, so it is an
// index that can be absent. Never index with it unchecked.
export type LdsLaneData = { lane: number; bank: number; phase: number };
export type LdsPatternData = {
  pc: number;
  name: string;
  isRead: boolean;
  // Nullable on the wire, unlike phases[].degree, for the same Go slice reason:
  // see the comment above on phases[].lanes. A pattern with no degree reaches the
  // UI only from a malformed or pre-existing body, and normalize floors it to 1.
  degree: number;
  stride: number;
  uniformStride: boolean;
  phaseModelApproximate: boolean;
  addressGranularityApproximate: boolean;
  repIsFirstSeen: boolean;
  // phases and lanes are BOTH nullable on the wire, for the same reason
  // phases[].lanes is: internal/ldsanalysis/drain.go builds each with append on a Go slice and
  // marshals the result, so a pattern the analyzer recorded no phases or no active
  // lanes for sends null rather than []. Neither is a deliberate value -- a Go
  // []int and a []struct have no null -- but both are reachable from a real run,
  // and a pattern that never becomes a row is exactly the shape that produces them.
  // So both are checked for being arrays at the boundary and become [] in the model.
  phases: LdsPhaseData[];
  lanes: LdsLaneData[];
  count: number;
  // instances and instancesTruncated describe the analyzer's per-pattern instance
  // list: the instruction task ids the pattern ran under, clipped at the analyzer's
  // own cap. They are declared here because they are on the wire, and they are NOT
  // typed as consumed by the UI because nothing consumes them. instances is not even
  // declared: the tab renders no id list, so a type that carried it would imply a
  // reader who could go looking for one. For the same reason the tab renders no
  // truncation flag, and the design's "the wave IDs where it occurs" was never
  // shipped as a visible list. What the tab does show is count, which the analyzer
  // keeps exact regardless of the clip.
  instancesTruncated: boolean;
};
export type LdsStatsData = { patterns: number; droppedExecutions: number; truncatedInstances: number };
export type LdsAnalysisData = { patterns: LdsPatternData[]; stats: LdsStatsData };

/**
 * One sample of the live stream, mirroring harness.Metrics field for field.
 *
 * Every cumulative field is a TO-DATE total, identical to what the finished
 * OTLP body reports for the same quantity, because both are produced by the same
 * collectors in package harness. A rate is therefore a difference between two of
 * these, never a field in one -- see lib/dashboard.ts.
 *
 * The numbers are plain JSON numbers rather than the strings OTLP uses for
 * int64. That is deliberate and it is a real difference from the metrics body: a
 * live sample is a gauge this app reads once, and JavaScript's integers are exact
 * to 2^53, which is 104 days of simulated time in picoseconds and 9 petabytes of
 * traffic. The OTLP body keeps its string encoding because a collector is a
 * different consumer with a different guarantee.
 */
export type Metrics = {
  simTimePs: number;
  /** The engine clock when the launch was enqueued; 0 before the first launch. */
  launchSimTimePs: number;
  kernelTimePs: number;
  vramUsedBytes: number;
  vramCapacityBytes: number;
  dramReadBytes: number;
  dramWriteBytes: number;
  /** The same two totals measured from the launch, which is what the panel plots. */
  dramReadSinceLaunchBytes: number;
  dramWriteSinceLaunchBytes: number;
  dramReadTransactions: number;
  dramWriteTransactions: number;
  activeCus: number;
  totalCus: number;
  activeSimds: number;
  totalSimds: number;
  waves: number;
  instructions: number;
  /** Keyed by cache level (L1V, L1S, L1I, L2). A level with no traffic yet is ABSENT. */
  cacheHitRate: Record<string, number>;
  tlbHitRate: number;
  /**
   * Traffic at each level of the memory hierarchy above DRAM, keyed by level name
   * ("L1", "L2", "MALL").
   *
   * A MAP and not fixed l1ReadBytes-style fields because the hierarchy differs by
   * device: CDNA3 has a MALL between L2 and DRAM and the R9 Nano has nothing there.
   * A level the device does not have is ABSENT, which is a different statement from
   * a level that is present and has seen no traffic.
   */
  memLevels?: Record<string, MemLevelSample>;
  /**
   * What each kernel moved, over every launch of it; the figures above are the
   * current launch's alone. Absent until the first launch.
   */
  kernelTraffic?: KernelTraffic[];
};

/** One kernel's traffic at one level, summed over every launch of it. */
export type KernelLevelSample = { readBytes: number; writeBytes: number };

/**
 * What one kernel moved, across every launch of it. One entry per distinct kernel
 * name in first-launched order, so a kernel in a loop is one series. Nothing is
 * removed or reordered: a chart addresses an entry by its index.
 */
export type KernelTraffic = {
  kernel: string;
  launches: number;
  /** The window this kernel ran in. The cumulative figure's shape says the same. */
  firstSimTimePs: number;
  lastSimTimePs: number;
  /** Keyed as memLevels is, plus "DRAM". A level the device lacks is absent. */
  levels: Record<string, KernelLevelSample>;
};

/** One level's traffic: total bytes plus the since-launch pair the panel plots. */
export type MemLevelSample = {
  readBytes: number;
  writeBytes: number;
  readSinceLaunchBytes: number;
  writeSinceLaunchBytes: number;
  readTransactions: number;
  writeTransactions: number;
};

// ---------------------------------------------------------------------------
// The dashboard, as the device that measured it describes it.
//
// These mirror harness/dashboard.go field for field. Every figure here is a device
// fact, and a list of them written in the website would be a guess about hardware in
// the wrong layer, so the device sends the shape of its own readout.
//
// A METRIC here is a chart (see ChartSchema): a title, units, and the sample
// paths its lines come from. `valueKind` is the only field that needs interpreting
// rather than reading, because a rate is not a field on a sample -- the simulator
// accumulates counters -- so the browser differences two of them itself.
// ---------------------------------------------------------------------------

/**
 * How a series's values are produced. Mirrors the kind* constants.
 *
 * - `value`: the field as it stands, one point per sample. Counts (lanes, CUs).
 * - `rate`: consecutive samples differenced against the simulated time between
 *   them, in GB/s. ONE FEWER point than there are samples, and its points are
 *   indexed by the interval that ENDED at a sample -- see seriesTimes.
 * - `bytes`: a byte count in MiB, one point per sample. MiB because the axis is
 *   labelled in axis units.
 */
export type ValueKind = "value" | "rate" | "bytes";

/**
 * One line on a chart.
 *
 * `path` is dot-separated into a sample ("dramReadSinceLaunchBytes",
 * "memLevels.L2.readSinceLaunchBytes") rather than a field name, because the
 * hierarchy's fields live in a MAP keyed by the device's own cache levels.
 */
export type SeriesSchema = {
  id: string;
  label: string;
  path: string;
  /** Which of the panel's four hues to draw it in: "read" | "write" | "share" | "memory". */
  hue: string;
};

/**
 * A flat line at a known ceiling -- the device's lane count, say.
 *
 * A series of COUNTS has no natural top, so the axis is scaled to the data's own
 * peak and a reader cannot see how much room is left. `label` is the unit, so the
 * line reads "256 lanes" rather than an unlabelled number.
 */
export type ReferenceSchema = {
  path: string;
  label: string;
};

/** A figure worth warning about: vram at 90% of capacity is the case that exists. */
export type WarnSchema = {
  path: string;
  capacityPath: string;
  atLeast: number;
};

/** How to read one kernel's share of a chart's level. See ChartSchema.kernelSeries. */
export type KernelSeriesSchema = { readPath: string; writePath: string };

/**
 * One chart.
 *
 * `note` is a TEMPLATE over the newest sample, not a string: the current figure
 * belongs in the heading, because a chart's y axis carries a scale and not a
 * value, so a reader who wants "how many right now" has to look at the last point
 * of a line, which is the one thing a line is bad at. See renderNote for the token
 * syntax.
 */
export type ChartSchema = {
  id: string;
  eyebrow: string;
  title: string;
  /** "full" for a chart on its own row, "pair" to sit beside the next paired one. */
  layout: string;
  valueKind: ValueKind;
  xUnit: string;
  yUnit: string;
  series: readonly SeriesSchema[];
  /**
   * This chart's per-kernel breakdown, absent on a chart that has none. The paths are
   * TEMPLATES with `%d` for the kernel's index: the schema is read before any kernel
   * runs, so it can only declare the shape, and the panel expands it from the newest
   * sample.
   */
  kernelSeries?: KernelSeriesSchema;
  note?: string;
  empty?: string;
  reference?: ReferenceSchema;
  warn?: WarnSchema;
};

/** One level of the memory hierarchy, with the two paths its traffic arrives on. */
export type HierarchyRow = {
  label: string;
  readPath: string;
  writePath: string;
};

/**
 * The strip of per-level traffic, innermost first, DRAM last.
 *
 * It exists because "DRAM read throughput is flat" has two very different causes
 * and the DRAM row alone cannot tell them apart: either the kernel barely read
 * anything, or it read plenty and none of it reached DRAM.
 *
 * No per-row "present" flag: a level this device lacks has no sample entry for its
 * path, and a path that resolves to nothing renders as "not present" -- a claim
 * about what has been measured. A zero would be a claim about traffic.
 */
export type HierarchySchema = {
  eyebrow: string;
  note: string;
  rows: readonly HierarchyRow[];
};

/** One hit rate and the sample path it is read from. */
export type MeterEntry = {
  label: string;
  path: string;
};

/**
 * The hit-rate grid. A meter and not a chart, because a hit rate converges on one
 * value: there is no shape over time to draw.
 */
export type MetersSchema = {
  eyebrow: string;
  title: string;
  note: string;
  entries: readonly MeterEntry[];
};

/**
 * The whole dashboard, read once per run off the simulator dashboardSchema export.
 *
 * Every figure in it is TO DATE, not instantaneous: a hit rate mid-run is the ratio
 * of two monotonic counts so far and converges on its final value. The one thing
 * that IS a rate is traffic, which is `valueKind: "rate"`.
 */
export type DashboardSchema = {
  title: string;
  runningEyebrow: string;
  finalEyebrow: string;
  runningBadge: string;
  finalBadge: string;
  /** Template for the badge's trailing text; see renderNote. */
  badge: string;
  hierarchy: HierarchySchema;
  charts: readonly ChartSchema[];
  meters: MetersSchema;
  footer: string;
};

export type TelemetryBundle = {
  metrics: OtlpMetricsData;
  lds: LdsAnalysisData;
};

/**
 * Cache and memory sizes for one run, in bytes.
 *
 * Every field is OPTIONAL and an absent field means "the device's own default",
 * which is why they are optional rather than zero: the simulator's builders read a
 * zero as a real, zero-sized cache, so a missing field has to be distinguishable
 * from a deliberate zero and only absence carries that.
 *
 * memoryBytes sets the modelled VRAM AND the allocator's limit together, because
 * they are one thing to a reader -- the number on the gauge is the number a kernel
 * is refused for exceeding. Setting them separately would let the panel show a
 * figure the allocator does not honour.
 */
export type SimOverrides = {
  /** L1 data cache size PER CU, so this is not the whole L1. */
  l1vBytes?: number;
  /** Whole L2, across its banks. */
  l2Bytes?: number;
  /** Whole MALL. Does nothing on a device with no MALL. */
  mallBytes?: number;
  /** Modelled device memory, and the allocator limit. */
  memoryBytes?: number;
};

export type SimRequest = {
  type: "run";
  hostWasm: ArrayBuffer;
  deviceCodeObject: ArrayBuffer;
  maxInst: number;
  device: string;
  /** Absent or partial means every unset size keeps the device default. */
  overrides?: SimOverrides;
};

// A request for the catalog with one device's figures read, answered by another
// `catalog` message.
//
// It exists because the simulator describes ONE device per catalog read -- reading
// a device's figures means building its platform -- while listing every device
// either way. So the page-load read asks for the default's figures and pays for
// one platform, and selecting a device nobody has run on asks for that device's.
//
// device is the name to describe, or "" for the registry default.
export type CatalogRequest = {
  type: "catalog-request";
  device: string;
};

/**
 * Save a new set of Customize sizes.
 *
 * Separate from a run because saving COSTS a platform rebuild: the sizes reach the
 * builders, so the harness holding the old platform has to be discarded and the
 * next one built from the new sizes. The reader is told when it has happened, which
 * is why this is its own message and not a field tacked onto the next run -- a
 * silent rebuild would be an unexplained pause, and one that happened on Run would
 * look like the sizes had been ignored.
 *
 * Absent fields mean "leave this one at the device default", so a save always
 * carries the whole set rather than a diff.
 */
export type ConfigureRequest = {
  type: "configure";
  overrides: SimOverrides;
};

export type SimResponse =
  | { type: "ready" }
  // What the simulator is, delivered at startup before any run and again after
  // every catalog request. It is not telemetry: nothing in it was measured, and
  // it is not forwarded to a collector. error is the Go-side message when the
  // export failed, so the About tab can say why rather than showing an empty
  // select. A read that fails after one succeeded keeps the body already in hand:
  // the device list it carries is still the simulator's, and blanking the select
  // because a re-read was refused would be a worse answer than the one on screen.
  | { type: "catalog"; body: CatalogBody | null; error?: string }
  // The outcome of a save. `body` is the catalog read AFTER the sizes were applied,
  // so the figures on screen are the ones the next run will build. A refusal
  // carries the simulator's own reason and changes nothing.
  | { type: "configured"; body: CatalogBody | null; error?: string }
  // What the SIMULATOR's Go runtime wrote, as opposed to what the compiled host
  // program wrote: a panic message and its stack trace, the instruction-cutoff note,
  // anything the harness prints. wasm_exec sends all of it to the browser's
  // developer console and nowhere else, which is a place a learner reading the
  // playground is not, so the worker taps it and posts it here instead. `kind` is
  // the fd it arrived on, which is the only thing distinguishing a panic from
  // ordinary output; the Console already has a rendering for each.
  | { type: "simulator-output"; kind: "stdout" | "stderr"; text: string }
  // The Go runtime stopped with this exit code, which is what a panic the harness
  // cannot recover looks like from the browser: it happened on the driver's engine
  // goroutine, so no export's deferred recover sees it, and the runtime prints the
  // stack and exits. Arrives AFTER the output above, since that is the order the
  // runtime writes it in, and it means the module is gone: the worker refuses
  // further work rather than posting into an instance with no exports.
  | { type: "crash"; code: number }
  | { type: "stdout"; text: string }
  // A live gauge sample, arriving several times a second WHILE the kernel runs.
  // The only message that can arrive mid-run besides output, and the only way
  // anything can be observed mid-run: the whole simulation executes inside one
  // synchronous drain() call, so the worker is blocked for its duration and no
  // page-to-worker message can be serviced. See harness/live.go.
  | { type: "metrics"; metrics: Metrics }
  // How to DRAW the live stream, read once per run from the dashboardSchema export
  // after the harness is built and before main() starts. A description of the
  // device rather than a measurement of anything, so it is not telemetry and is
  // not forwarded to a collector -- but it does belong to the run it describes,
  // so it is run-scoped like `live` and gated on the run id with it: a schema
  // from a superseded run would draw this run's charts in the other device's
  // units, which is the one thing a reader cannot see was wrong.
  | { type: "dashboard-schema"; schema: DashboardSchema }
  | { type: "result"; telemetry: TelemetryBundle; forwardingError?: string }
  | { type: "error"; message: string; telemetry?: TelemetryBundle; forwardingError?: string };

export type CompileRequest = {
  type: "compile";
  source: string;
  /**
   * The toolchain to compile the device side with, as the selected device's
   * catalog entry named it. Required with no fallback: the build carries no ISA,
   * so the device is the only thing that can say which toolchain and which target.
   * See src/lib/toolchains.ts.
   */
  toolchainId: string;
  /** The device those two come from; the worker forwards it so the pipeline can cross-check the pair. */
  device: string;
  /** The ISA to emit, taken from the same catalog entry as `toolchainId`. */
  arch: string;
};

export type CompileResponse =
  | { type: "download-progress"; loaded: number; total: number | null }
  | { type: "stage"; stage: "device" | "host" | "link" }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "result"; deviceCodeObject: ArrayBuffer; hostWasm: ArrayBuffer }
  | { type: "error"; message: string };
