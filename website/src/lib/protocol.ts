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

export type LdsPhaseData = {
  firstLane: number;
  lastLane: number;
  lanes: number[] | null;
  degree: number;
  bankAddrs: number[] | null;
};
export type LdsLaneData = { lane: number; bank: number; phase: number; addrs?: number[] | null };
export type LdsPatternData = {
  // pc is an OFFSET WITHIN THE KERNEL'S CODE, not a device address: the same value in
  // every run of one kernel, and what indexes a disassembly or a line table.
  pc: number;
        sourceFile?: string;
  sourceLine?: number;
  name: string;
  isRead: boolean;
        degree: number;
  stride: number;
  uniformStride: boolean;
  phaseModelApproximate: boolean;
  addressGranularityApproximate: boolean;
  repIsFirstSeen: boolean;
                phases: LdsPhaseData[];
  lanes: LdsLaneData[];
  count: number;
                    instancesTruncated: boolean;
};
export type LdsStatsData = { patterns: number; droppedExecutions: number; truncatedInstances: number };
export type LdsAnalysisData = { patterns: LdsPatternData[]; stats: LdsStatsData };

export type Metrics = {
  simTimePs: number;
    launchSimTimePs: number;
  kernelTimePs: number;
  vramUsedBytes: number;
  vramCapacityBytes: number;
  dramReadBytes: number;
  dramWriteBytes: number;
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
    cacheHitRate: Record<string, number>;
  tlbHitRate: number;
    memLevels?: Record<string, MemLevelSample>;
    kernelTraffic?: KernelTraffic[];
};

export type KernelLevelSample = { readBytes: number; writeBytes: number };

export type KernelTraffic = {
  kernel: string;
  launches: number;
    firstSimTimePs: number;
  lastSimTimePs: number;
    levels: Record<string, KernelLevelSample>;
};

export type MemLevelSample = {
  readBytes: number;
  writeBytes: number;
  readSinceLaunchBytes: number;
  writeSinceLaunchBytes: number;
  readTransactions: number;
  writeTransactions: number;
};

export type ValueKind = "value" | "rate" | "bytes";

export type SeriesSchema = {
  id: string;
  label: string;
  path: string;
    hue: string;
};

export type ReferenceSchema = {
  path: string;
  label: string;
};

export type WarnSchema = {
  path: string;
  capacityPath: string;
  atLeast: number;
};

export type KernelSeriesSchema = { readPath: string; writePath: string };

export type ChartSchema = {
  id: string;
  eyebrow: string;
  title: string;
    layout: string;
  valueKind: ValueKind;
  xUnit: string;
  yUnit: string;
  series: readonly SeriesSchema[];
    kernelSeries?: KernelSeriesSchema;
  note?: string;
  empty?: string;
  reference?: ReferenceSchema;
  warn?: WarnSchema;
};

export type HierarchyRow = {
  label: string;
  readPath: string;
  writePath: string;
};

export type HierarchySchema = {
  eyebrow: string;
  note: string;
  rows: readonly HierarchyRow[];
};

export type MeterEntry = {
  label: string;
  path: string;
};

export type MetersSchema = {
  eyebrow: string;
  title: string;
  note: string;
  entries: readonly MeterEntry[];
};

export type DashboardSchema = {
  title: string;
  runningEyebrow: string;
  finalEyebrow: string;
  runningBadge: string;
  finalBadge: string;
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

export type SimOverrides = {
    l1vBytes?: number;
    l2Bytes?: number;
    mallBytes?: number;
    memoryBytes?: number;
};

export type SimRequest = {
  type: "run";
  hostWasm: ArrayBuffer;
  deviceCodeObject: ArrayBuffer;
  maxInst: number;
  device: string;
    overrides?: SimOverrides;
};

export type CatalogRequest = {
  type: "catalog-request";
  device: string;
};

export type ConfigureRequest = {
  type: "configure";
  overrides: SimOverrides;
};

export type SimResponse =
  | { type: "ready" }
                | { type: "catalog"; body: CatalogBody | null; error?: string }
        | { type: "configured"; body: CatalogBody | null; error?: string }
                | { type: "simulator-output"; kind: "stdout" | "stderr"; text: string }
              | { type: "crash"; code: number }
  | { type: "stdout"; text: string }
            | { type: "metrics"; metrics: Metrics }
                | { type: "dashboard-schema"; schema: DashboardSchema }
  | { type: "result"; telemetry: TelemetryBundle; forwardingError?: string }
  | { type: "error"; message: string; telemetry?: TelemetryBundle; forwardingError?: string };

export type CompileRequest = {
  type: "compile";
  source: string;
    toolchainId: string;
    device: string;
    arch: string;
};

export type CompileResponse =
  | { type: "download-progress"; loaded: number; total: number | null }
  | { type: "stage"; stage: "device" | "host" | "link" }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "result"; deviceCodeObject: ArrayBuffer; hostWasm: ArrayBuffer }
  | { type: "error"; message: string };
