import type { LdsLane, LdsModel, LdsPattern, LdsPhase } from "./ldsModel";
import { LDS_BANK_COUNT } from "./ldsModel";

// The logic behind the LDS tab, kept out of the component so it can be tested
// without a renderer. Nothing here re-ranks a pattern or re-derives the model's
// notes: those arrive from selectLdsModel and pass through untouched.

// The row width comes from ldsModel, which needs it to normalize a phase's per-bank
// counts; it is re-exported here because this is the module the component reads.
export { LDS_BANK_COUNT };

export type LdsBankCell = {
  bank: number;
  lanes: LdsLane[];
};

// One column of the bank map: how deep a bank is, and therefore whether it is
// conflicted. Height and verdict are the same number, so a deep column that is not
// a conflict cannot be drawn.
export type LdsBankColumn = {
  bank: number;
  // addrs is the number of DISTINCT addresses this bank saw in the busiest phase,
  // which is the number the phase degree is the maximum of. Lanes sharing one
  // address do not make it deeper.
  addrs: number;
  // conflicted is addrs > 1, spelled out so a caller never has to know it.
  conflicted: boolean;
  // height is addrs against the tallest column in the access, so the scale is
  // always used and always relative. Read the label for the number.
  height: number;
  // phase is the phase the count came from, or -1 when the bank saw nothing at all.
  phase: number;
};

// A phase with no bankAddrs contributed no counts, which is the same as an
// all-zero row.
function bankAddrsOf(phase: LdsPhase): number[] {
  return Array.isArray(phase.bankAddrs) ? phase.bankAddrs : [];
}

/**
 * One column per bank, drawn from the analyzer's per-bank distinct-address counts.
 * This is what the bank map is rendered from.
 *
 * A column takes the busiest phase's count for its bank, so the tallest column is
 * the access's degree. Never a lane count: a 64-lane broadcast puts 64 lanes in
 * bank 0 and one address there, and drawing the 64 would report the cheapest access
 * in the ISA as a 64-way conflict.
 */
export function ldsBankColumns(pattern: LdsPattern, bankCount: number = LDS_BANK_COUNT): LdsBankColumn[] {
  const addrs = new Array<number>(bankCount).fill(0);
  const phaseOf = new Array<number>(bankCount).fill(-1);

  pattern.phases.forEach((phase, index) => {
    for (let bank = 0; bank < bankCount; bank++) {
      // bankAddrs is widened to the full row at the boundary, so a short index is
      // a bank this phase did not touch.
      const seen = bankAddrsOf(phase)[bank] ?? 0;
      if (seen > addrs[bank]) {
        addrs[bank] = seen;
        phaseOf[bank] = index;
      }
    }
  });

  const deepest = addrs.reduce((most, n) => Math.max(most, n), 0);
  return addrs.map((seen, bank) => ({
    bank,
    addrs: seen,
    conflicted: seen > 1,
    height: deepest > 0 ? seen / deepest : 0,
    phase: phaseOf[bank],
  }));
}

/**
 * Whether the analysis actually reported per-bank counts. False means every phase
 * came back all zeros, so a degree above 1 must not draw as a clean map.
 */
export function ldsBankCountsReported(pattern: LdsPattern): boolean {
  return pattern.phases.some((phase) => bankAddrsOf(phase).some((n) => n > 0));
}

function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`);
}

/**
 * LDS_BANK_COUNT cells, each carrying the lanes that land in it. This is the LANE
 * view, for the per-lane table and the bank-map tooltips, and it is not what the
 * map is drawn from: a lane count cannot say whether a bank is conflicted. So
 * nothing here reports crowding or any other verdict.
 */
export function ldsBankOccupancy(pattern: LdsPattern, bankCount: number = LDS_BANK_COUNT): LdsBankCell[] {
  const cells: LdsBankCell[] = Array.from({ length: bankCount }, (_, bank) => ({ bank, lanes: [] }));
  for (const lane of pattern.lanes) {
    // bank is a dword index modulo 32 upstream; skipping an out-of-range value
    // keeps a malformed body from writing past the array. Cells are grouped by bank
    // alone: a lane's phase is deliberately not consulted.
    if (!Number.isInteger(lane.bank) || lane.bank < 0 || lane.bank >= bankCount) continue;
    cells[lane.bank].lanes.push(lane);
  }
  return cells;
}

// The lane axis the phase strip is drawn against: the highest lane any part of the
// pattern names, and at least one lane so the axis is never a zero-width divide.
export function ldsLaneCount(pattern: LdsPattern): number {
  const fromLanes = pattern.lanes.reduce((most, lane) => Math.max(most, lane.lane + 1), 0);
  const fromPhases = pattern.phases.reduce((most, phase) => Math.max(most, phase.lastLane + 1), 0);
  return Math.max(1, fromLanes, fromPhases);
}

// The most lanes the hardware tries to serve in one phase, which decides the
// degree -- not the wave's 64. An inactive lane range or an empty phase yields 0.
export function ldsPeakPhaseLanes(pattern: LdsPattern): number {
  return pattern.phases.reduce((most, phase) => Math.max(most, phase.lanes.length), 0);
}

// The per-lane table's phase cell. A lane with phase -1 is labelled rather than
// printed as an index a reader would try to look up.
export function ldsLanePhaseLabel(lane: LdsLane, phases: LdsPhase[]): string {
  if (!Number.isInteger(lane.phase) || lane.phase < 0 || lane.phase >= phases.length) return "no phase";
  const phase = phases[lane.phase];
  return `lanes ${phase.firstLane}–${phase.lastLane}`;
}

// Whether every pattern carries a real degree. A degree of 1 is the analyzer having
// looked and found nothing; 0 or below is the absent-attribute sentinel.
export function ldsAllMeasured(model: LdsModel): boolean {
  return model.patterns.every((pattern) => pattern.degree >= 1);
}

// "No conflicts" gets a sentence that says which of the two readings it is. Null
// when there is a conflict to look at.
export function ldsCleanNote(model: LdsModel): string | null {
  if (model.conflicted > 0) return null;
  if (!ldsAllMeasured(model)) {
    return "No access in this run reported a conflict degree, so this is an absence of measurement rather than a clean result.";
  }
  return "No access in this run is conflicted: every __shared__ read and write places at most one address in a bank per phase, so each phase is served in a single cycle.";
}

export function ldsSummaryLines(model: LdsModel): string[] {
  const count = model.patterns.length;
  const lines = [
    `${count} distinct ${plural(count, "access pattern")}`,
    model.conflicted === 0 ? "no bank conflicts" : `${model.conflicted} of ${count} conflicted`,
  ];
  // worstDegree floors at 1, so "worst 1-way" for a clean kernel would dress up a
  // non-result as a measurement.
  if (model.conflicted > 0) lines.push(`worst ${model.worstDegree}-way`);
  else lines.push(ldsAllMeasured(model) ? "conflict-free as modelled" : "no degrees reported");
  return lines;
}

/**
 * What the access does, before any conflict is mentioned: direction, how many lanes
 * a phase holds, how many phases, and the stride. The stride is stated as a property
 * of the access rather than as the cause of the degree.
 *
 * The lane count is the DEEPEST phase, so it is a ceiling: a partly inactive phase
 * holds fewer, and a flat figure would overstate it.
 */
export function ldsAccessSentence(pattern: LdsPattern): string {
  const lanes = ldsPeakPhaseLanes(pattern);
  const phaseCount = pattern.phases.length;
  if (lanes === 0) {
    return `${pattern.name} was recorded with no active lane in any phase, so it moved no data.`;
  }
  const stride = pattern.uniformStride
    ? `a uniform ${pattern.stride}-byte stride between lanes`
    : pattern.stride === 0
      ? "no measurable stride, because the first phase holds fewer than two active lanes"
      : `a ${pattern.stride}-byte stride in the first phase, which is not uniform across it`;
  return `${pattern.name} ${pattern.isRead ? "reads" : "writes"} up to ${lanes} ${plural(lanes, "lane")} at a time across ${phaseCount} ${plural(phaseCount, "phase")}, ${stride}.`;
}

// Why the degree is what it is. The two conflict-free readings are kept apart:
// degree 1 is the analyzer having looked and found nothing, and a degree at or below
// 0 is it having nothing to report.
export function ldsDegreeSentence(pattern: LdsPattern): string {
  if (pattern.degree > 1) {
    return `Degree ${pattern.degree}: the busiest bank holds ${pattern.degree} different addresses at once within one phase, so the hardware would serve that phase in ${pattern.degree} cycles instead of one.`;
  }
  if (pattern.degree === 1) {
    return "Degree 1: no bank holds two different addresses at once within a phase, so every phase is served in a single cycle.";
  }
  return "The analyzer reported no degree for this access, so nothing can be said about its bank conflicts.";
}

// What the drain had to leave behind, phrased so the count is not confused for a
// per-row one: droppedExecutions counts accesses that never became a row.
export function ldsStatsNote(model: LdsModel): string | null {
  const notes: string[] = [];
  if (model.stats.droppedExecutions > 0) {
    notes.push(`The analyzer dropped ${model.stats.droppedExecutions} ${plural(model.stats.droppedExecutions, "execution")} past its pattern cap, so this list is not every access in the run.`);
  }
  return notes.length === 0 ? null : notes.join(" ");
}

// The selected row, clamped: a run finishes with a fresh analysis while the tab
// may still hold an index that no longer exists.
export function selectLdsPattern(model: LdsModel | null, index: number): LdsPattern | null {
  if (model === null || model.patterns.length === 0) return null;
  if (!Number.isFinite(index)) return model.patterns[0];
  const clamped = Math.min(Math.max(Math.trunc(index), 0), model.patterns.length - 1);
  return model.patterns[clamped] ?? null;
}
