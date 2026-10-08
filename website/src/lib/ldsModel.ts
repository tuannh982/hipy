import type { LdsAnalysisData, LdsLaneData, LdsPatternData, LdsPhaseData, LdsStatsData } from "./protocol";

export const LDS_BANK_COUNT = 32;

export type LdsPhase = {
  firstLane: number;
  lastLane: number;
  lanes: number[];
  degree: number;
          bankAddrs: number[];
};

export type LdsLane = { lane: number; bank: number; phase: number; addrs: number[] };

export type LdsPattern = {
  // pc is an offset within the kernel's code, not a device address. See
  // ldswire.LdsPattern.
  pc: number;
  // The code object's DWARF line table's answer for pc, already resolved by the
  // harness. Line 0 with an empty file means no line table was carried.
  sourceFile: string;
  sourceLine: number;
  name: string;
  isRead: boolean;
  degree: number;
  stride: number;
  uniformStride: boolean;
  phaseModelApproximate: boolean;
  addressGranularityApproximate: boolean;
  repIsFirstSeen: boolean;
  phases: LdsPhase[];
  lanes: LdsLane[];
  count: number;
  instancesTruncated: boolean;
};

export type LdsModel = {
  patterns: LdsPattern[];
  conflicted: number;
  worstDegree: number;
  // approximate names the model choices that are inferred rather than sourced, so
  // the UI can say so instead of presenting every degree as measured.
  approximate: string[];
  // stats is what the drain had to leave behind, carried through so the UI reports
  // dropped executions and truncated instance lists without reaching past the model.
  stats: LdsStats;
};

export type LdsStats = { patterns: number; droppedExecutions: number; truncatedInstances: number };

const severityBands = [
  { id: "none", color: "#64748b", min: 1 },
  { id: "mild", color: "#facc15", min: 2 },
  { id: "moderate", color: "#fb923c", min: 4 },
  { id: "severe", color: "#ef4444", min: 8 },
] as const;

type SeverityBand = (typeof severityBands)[number];

const conflictFreeLabel = "No conflict";

export function ldsSeverity(degree: number): { id: string; label: string; color: string } {
  const d = Number.isFinite(degree) && degree > 0 ? Math.trunc(degree) : 1;
  let band: SeverityBand = severityBands[0];
  for (const candidate of severityBands) {
    if (d >= candidate.min) band = candidate;
  }
  return { id: band.id, label: d === 1 ? conflictFreeLabel : `${d}-way`, color: band.color };
}

export function ldsSeverityBands(): { id: string; color: string; from: number }[] {
  return severityBands.map((band) => ({ id: band.id, color: band.color, from: band.min }));
}

function normalizeBankAddrs(raw: Partial<LdsPhaseData>): number[] {
  const out = new Array<number>(LDS_BANK_COUNT).fill(0);
  if (!Array.isArray(raw.bankAddrs)) return out;
  for (let bank = 0; bank < LDS_BANK_COUNT; bank++) {
    const value = raw.bankAddrs[bank];
    out[bank] = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }
  return out;
}

// An LDS byte offset is a whole non-negative number; anything else is a malformed body.
// Unlike sourceLine, not truncated, since a fractional LINE has a real line it aimed at.
function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Math.trunc(value) === value;
}

function normalizePhase(raw: Partial<LdsPhaseData>): LdsPhase {
  return {
    firstLane: raw.firstLane ?? 0,
    lastLane: raw.lastLane ?? 0,
    lanes: Array.isArray(raw.lanes) ? raw.lanes : [],
    degree: raw.degree ?? 1,
    bankAddrs: normalizeBankAddrs(raw),
  };
}

// A non-array becomes [], which the UI reports as "not reported".
function normalizeLane(raw: Partial<LdsLaneData>): LdsLane {
  const addrs = Array.isArray(raw.addrs) ? raw.addrs.filter(isOffset) : [];
  return {
    lane: raw.lane ?? -1,
    bank: raw.bank ?? -1,
    phase: raw.phase ?? -1,
    addrs,
  };
}

function normalize(raw: Partial<LdsPatternData>): LdsPattern {
  return {
    pc: raw.pc ?? 0,
    // Both a body predating the fields and a code object compiled without a line table
    // arrive as the same "nothing was mapped" pair. hasSource is the only way to ask.
    sourceFile: typeof raw.sourceFile === "string" ? raw.sourceFile : "",
    sourceLine: typeof raw.sourceLine === "number" && Number.isFinite(raw.sourceLine) && raw.sourceLine > 0
      ? Math.trunc(raw.sourceLine)
      : 0,
    name: raw.name ?? "",
    isRead: raw.isRead ?? false,
    degree: raw.degree ?? 1,
    stride: raw.stride ?? 0,
    uniformStride: raw.uniformStride ?? false,
    phaseModelApproximate: raw.phaseModelApproximate ?? false,
    addressGranularityApproximate: raw.addressGranularityApproximate ?? false,
    repIsFirstSeen: raw.repIsFirstSeen ?? true,
    phases: Array.isArray(raw.phases) ? raw.phases.map(normalizePhase) : [],
    // Normalized per lane, so one malformed lane does not cost the other 63 their addresses.
    lanes: Array.isArray(raw.lanes) ? raw.lanes.map(normalizeLane) : [],
    count: raw.count ?? 0,
    instancesTruncated: raw.instancesTruncated ?? false,
  };
}

function normalizeStats(raw: Partial<LdsStatsData> | undefined): LdsStats {
  return {
    patterns: raw?.patterns ?? 0,
    droppedExecutions: raw?.droppedExecutions ?? 0,
    truncatedInstances: raw?.truncatedInstances ?? 0,
  };
}

export function selectLdsModel(data: LdsAnalysisData | null, targetArch: string | null): LdsModel | null {
  if (!data || !Array.isArray(data.patterns) || data.patterns.length === 0) return null;

  const patterns = data.patterns
    .map(normalize)
    .sort((left, right) => (right.degree - left.degree) || (right.count - left.count));

        const arch = typeof targetArch === "string" ? targetArch.trim() : "";

  const approximate: string[] = [];
  if (patterns.some((p) => p.phaseModelApproximate)) {
    approximate.push(
      `The ds_read_b128 phase grouping is modelled as contiguous; AMD documents a different grouping for MI-series LDS, unconfirmed for ${arch === "" ? "the selected target" : arch}.`,
    );
  }
  if (patterns.some((p) => p.addressGranularityApproximate)) {
    approximate.push("A sub-word conflict is keyed on the containing dword, and the byte phase width is inferred; no AMD source states either.");
  }

  return {
    patterns,
    conflicted: patterns.filter((p) => p.degree > 1).length,
    // The floor of 1 is deliberate: 0 is the sentinel the Go side says must never
    // reach the UI.
    worstDegree: patterns.reduce((worst, p) => Math.max(worst, p.degree), 1),
    approximate,
    stats: normalizeStats(data.stats),
  };
}
