import type { LdsAnalysisData, LdsPatternData, LdsPhaseData, LdsStatsData } from "./protocol";

// The LDS is 32 banks of 4 bytes, one 128-byte row, so the bank map is always 32
// columns wide however few banks a given access touches. It lives here rather than
// in ldsView because normalize needs it to widen a phase's bankAddrs to the full
// row. ldsView re-exports it.
export const LDS_BANK_COUNT = 32;

// lanes is never null here: a null from the wire is normalized to [] at the boundary,
// so no caller of the model can be handed a null and crash on .length.
//
// bankAddrs is never short here and never null: it is widened to one entry per bank
// at the same boundary, so bankAddrs[b] is safe to index for any bank in the row.
export type LdsPhase = {
  firstLane: number;
  lastLane: number;
  lanes: number[];
  degree: number;
  // bankAddrs[b] is how many distinct addresses bank b saw in this phase. It is not
  // a lane count, and that is what makes it usable: lanes reaching one bank at one
  // address are a broadcast that costs one cycle. The largest entry is the phase's
  // degree.
  bankAddrs: number[];
};

// phase is an index into the pattern's phases, and it is -1 for an active lane that
// matches no phase's lane range. A caller that wants the phase's degree must check
// phase >= 0 first; there is no phase at that index.
export type LdsLane = { lane: number; bank: number; phase: number };

export type LdsPattern = {
  pc: number;
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

// The degree is the number the reader can act on, so the label is the degree and
// nothing else: a band name that only restates it ("2-way (2-way)") is noise in
// user-facing text. The conflict-free case is the one with no degree to print.
const conflictFreeLabel = "No conflict";

/**
 * A degree of 1 is conflict-free, so it grades as "none" rather than sharing a band
 * with a conflict, and the absent-attribute default -1 collides with no real degree.
 *
 * IMPORTANT FOR CALLERS: -1, 0 and 1 all return the identical {id, label, color}
 * triple. This cannot tell "no conflict" from "nothing measured", so anything needing
 * that distinction must branch on the raw degree.
 */
export function ldsSeverity(degree: number): { id: string; label: string; color: string } {
  const d = Number.isFinite(degree) && degree > 0 ? Math.trunc(degree) : 1;
  let band: SeverityBand = severityBands[0];
  for (const candidate of severityBands) {
    if (d >= candidate.min) band = candidate;
  }
  return { id: band.id, label: d === 1 ? conflictFreeLabel : `${d}-way`, color: band.color };
}

/**
 * The per-bank distinct-address counts, widened to the full row of banks.
 *
 * A missing or short array is padded with zeros, so an access with lanes and no
 * counts degrades to a map with nothing in it rather than to a throw. That
 * degradation is a real loss of information and the panel says so. An entry that is
 * not a finite non-negative integer is treated the same way.
 */
function normalizeBankAddrs(raw: Partial<LdsPhaseData>): number[] {
  const out = new Array<number>(LDS_BANK_COUNT).fill(0);
  if (!Array.isArray(raw.bankAddrs)) return out;
  for (let bank = 0; bank < LDS_BANK_COUNT; bank++) {
    const value = raw.bankAddrs[bank];
    out[bank] = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }
  return out;
}

// phases[].lanes is the one nested array the wire can send as null (a phase whose
// whole lane range is inactive is never appended to by the analyzer, so Go marshals
// a nil slice as null). Normalized here, at the boundary.
function normalizePhase(raw: Partial<LdsPhaseData>): LdsPhase {
  return {
    firstLane: raw.firstLane ?? 0,
    lastLane: raw.lastLane ?? 0,
    lanes: Array.isArray(raw.lanes) ? raw.lanes : [],
    degree: raw.degree ?? 1,
    bankAddrs: normalizeBankAddrs(raw),
  };
}

function normalize(raw: Partial<LdsPatternData>): LdsPattern {
  return {
    pc: raw.pc ?? 0,
    name: raw.name ?? "",
    isRead: raw.isRead ?? false,
    degree: raw.degree ?? 1,
    stride: raw.stride ?? 0,
    uniformStride: raw.uniformStride ?? false,
    phaseModelApproximate: raw.phaseModelApproximate ?? false,
    addressGranularityApproximate: raw.addressGranularityApproximate ?? false,
    repIsFirstSeen: raw.repIsFirstSeen ?? true,
    phases: Array.isArray(raw.phases) ? raw.phases.map(normalizePhase) : [],
    lanes: Array.isArray(raw.lanes) ? raw.lanes : [],
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

/**
 * targetArch is the arch the kernel was compiled for, which is what the caveats are
 * about. An argument rather than a module-level read so this selector stays pure and
 * no caller can be handed a caveat naming a device it is not running on. Nullable,
 * passed through rather than papered over: it is null until the catalog answers.
 */
export function selectLdsModel(data: LdsAnalysisData | null, targetArch: string | null): LdsModel | null {
  if (!data || !Array.isArray(data.patterns) || data.patterns.length === 0) return null;

  const patterns = data.patterns
    .map(normalize)
    .sort((left, right) => (right.degree - left.degree) || (right.count - left.count));

  // An absent or blank arch renders as prose rather than as "unconfirmed for
  // undefined" or "unconfirmed for .": a caveat that names no arch is still a true
  // caveat.
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

