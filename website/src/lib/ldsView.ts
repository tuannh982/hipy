import type { LdsLane, LdsModel, LdsPattern, LdsPhase } from "./ldsModel";
import { LDS_BANK_COUNT, ldsSeverityBands } from "./ldsModel";

// Re-exported because this is the module the component reads.
export { LDS_BANK_COUNT };

export type LdsBankCell = {
  bank: number;
  lanes: LdsLane[];
};

export type LdsBankColumn = {
  bank: number;
  // Distinct addresses in the busiest phase: the count the degree is the max of.
  // Lanes sharing one address do not deepen the bank.
  addrs: number;
  // conflicted is addrs > 1, spelled out so a caller never has to know it.
  conflicted: boolean;
  // addrs against the tallest column, so the scale is always used and always relative.
  height: number;
  // phase is the phase the count came from, or -1 when the bank saw nothing at all.
  phase: number;
};

// A phase with no bankAddrs contributed no counts: the same as an all-zero row.
function bankAddrsOf(phase: LdsPhase): number[] {
  return Array.isArray(phase.bankAddrs) ? phase.bankAddrs : [];
}

export function ldsBankColumns(pattern: LdsPattern, bankCount: number = LDS_BANK_COUNT): LdsBankColumn[] {
  const addrs = new Array<number>(bankCount).fill(0);
  const phaseOf = new Array<number>(bankCount).fill(-1);

  pattern.phases.forEach((phase, index) => {
    for (let bank = 0; bank < bankCount; bank++) {
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

export function ldsBankCountsReported(pattern: LdsPattern): boolean {
  return pattern.phases.some((phase) => bankAddrsOf(phase).some((n) => n > 0));
}

function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`);
}

function counted(count: number, one: string, many?: string): string {
  return `${count} ${plural(count, one, many)}`;
}

export function ldsBankOccupancy(pattern: LdsPattern, bankCount: number = LDS_BANK_COUNT): LdsBankCell[] {
  const cells: LdsBankCell[] = Array.from({ length: bankCount }, (_, bank) => ({ bank, lanes: [] }));
  for (const lane of pattern.lanes) {
    // Grouped by bank alone: a lane's phase is deliberately not consulted.
    if (!Number.isInteger(lane.bank) || lane.bank < 0 || lane.bank >= bankCount) continue;
    cells[lane.bank].lanes.push(lane);
  }
  return cells;
}

// The lane axis the phase strip is drawn against, at least one so the axis is never
// a zero-width divide.
export function ldsLaneCount(pattern: LdsPattern): number {
  const fromLanes = pattern.lanes.reduce((most, lane) => Math.max(most, lane.lane + 1), 0);
  const fromPhases = pattern.phases.reduce((most, phase) => Math.max(most, phase.lastLane + 1), 0);
  return Math.max(1, fromLanes, fromPhases);
}

// The per-lane table's phase cell. A lane with phase -1 is labelled rather than printed
// as an index a reader would try to look up.
export function ldsLanePhaseLabel(lane: LdsLane, phases: LdsPhase[]): string {
  if (!Number.isInteger(lane.phase) || lane.phase < 0 || lane.phase >= phases.length) return "no phase";
  const phase = phases[lane.phase];
  return `lanes ${phase.firstLane}–${phase.lastLane}`;
}

// A degree of 1 is the analyzer having looked and found nothing; 0 or below is the
// absent-attribute sentinel.
export function ldsAllMeasured(model: LdsModel): boolean {
  return model.patterns.every((pattern) => pattern.degree >= 1);
}

// Null when there is a conflict to look at.
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

export function ldsAccessSentence(pattern: LdsPattern): string {
  const opcode = ldsOpcode(pattern.name);
  const lanes = ldsLaneCount(pattern);
  if (lanes === 0) {
    return `${pattern.name} was recorded with no active lane in any phase, so it moved no data.`;
  }
  const phaseCount = pattern.phases.length;
  const footprint = !opcode.known
    ? "an unknown number of bytes"
    : opcode.addrsPerLane === 1
      ? `${opcode.bytesPerLane} B`
      : `${opcode.bytesPerLane} B in ${opcode.addrsPerLane} addresses`;
  const stride = pattern.uniformStride
    ? `a uniform ${pattern.stride} B stride between lanes`
    : pattern.stride === 0
      ? "no measurable stride (its first phase holds fewer than two active lanes)"
      : `a ${pattern.stride} B stride in the first phase, which is not uniform across it`;
  return `${opcode.known ? opcode.name : pattern.name || "This opcode"} ${pattern.isRead ? "reads" : "writes"} ${footprint} per lane, ${stride}. `
    + `${lanes} active lanes run in ${phaseCount} ${plural(phaseCount, "phase")}.`;
}

export function ldsDegreeSentence(pattern: LdsPattern): string {
  const group = ldsBusiestGroup(pattern);
  const cost = `A bank is ${BANK_BYTES} B wide and retires one address per cycle`;
        const race = pattern.isRead
    ? ""
    : " Lanes storing to the same address count once, so a write race between them would not show up here.";
  if (pattern.degree > 1 && group !== null) {
    const reach = `${counted(group.laneCount, "lane")} at ${group.addrs} different ${plural(group.addrs, "address", "addresses")}`;
    const missing = group.lanes.length === 0
      ? " (this analysis reported no lane addresses, so the offsets cannot be named)"
      : ` — ${describeGroup(pattern, group)}`;
    return `Degree ${pattern.degree}: in phase ${group.phase}, bank ${group.bank} was reached by ${reach}${missing}. `
      + `${cost}, so that phase takes ${group.addrs} ${plural(group.addrs, "cycle")} instead of one.${race}`;
  }
  if (pattern.degree > 1) {
    // No per-bank counts at all, so nothing can be attributed to a bank.
    return `Degree ${pattern.degree}: one phase put ${pattern.degree} different ${plural(pattern.degree, "address", "addresses")} into a single bank, ${cost}, so that phase takes ${pattern.degree} cycles instead of one. `
      + `This analysis reported no per-bank address counts, so no bank or lane can be named.${race}`;
  }
  if (pattern.degree > 1) {
    // No per-bank counts at all: the cost is measured but nothing can be attributed
    // to a bank, and naming one would be the one number a reader would act on.
    return `Degree ${pattern.degree}: one phase put ${pattern.degree} different ${plural(pattern.degree, "address", "addresses")} into a single bank, ${cost}, so that phase takes ${pattern.degree} cycles instead of one. `
      + `This analysis reported no per-bank address counts, so no bank or lane can be named.${race}`;
  }
  if (pattern.degree === 1) {
    const busiest = group === null
      ? ""
      : ` The busiest bank was ${group.bank} in phase ${group.phase}, where ${counted(group.laneCount, "lane")} reached it at one address`
        + (group.lanes.length === 0
          ? " (this analysis reported no lane addresses, so the offset cannot be named)."
          : `: ${describeGroup(pattern, group)}.`);
    return `Degree 1: no bank held two different addresses at once within a phase, so every phase is served in a single cycle.${busiest}`
      + ` Lanes sharing one address cost one cycle however many of them there are.${race}`;
  }
  return "The analyzer reported no degree for this access, so nothing can be said about its bank conflicts.";
}

// How many of a group's addresses a sentence names before it abbreviates.
const GROUP_DETAIL_LIMIT = 4;
// How many lane ids it names per address: a broadcast is one fact however many share it.
const LANE_DETAIL_LIMIT = 4;

// The busiest (phase, bank) pair in the access: the one whose address count IS the
// degree. Ties go to the lowest phase then bank, so a sentence is stable across renders.
export type LdsBankGroup = {
  phase: number;
  bank: number;
  // addrs is the count the degree rests on, read off the wire rather than recounted.
  addrs: number;
  // lanes is one entry per distinct address, each naming the lanes at it.
  lanes: LdsBankAddress[];
  // laneCount counts DISTINCT lanes, fewer than the sum of the entries' lane lists
  // whenever lanes share an address.
  laneCount: number;
};

export type LdsBankAddress = { addr: number; lanes: number[] };

export function ldsBankTooltip(pattern: LdsPattern, column: LdsBankColumn): string {
  const where = column.phase < 0 ? "in no phase" : `in its busiest phase, phase ${column.phase}`;
  if (column.addrs === 0) {
    return `bank ${column.bank}: no lane reached it in any phase`;
  }
  const cost = column.addrs === 1
    ? ", so the hardware serves it in one cycle"
    : `, so the hardware serves it in ${column.addrs} cycles`;
  const addresses = ldsBankAddresses(pattern, column.phase, column.bank);
  if (addresses.length === 0) {
    return `bank ${column.bank}: ${column.addrs} different ${plural(column.addrs, "address", "addresses")} ${where}`
      + " (this analysis reported no lane addresses, so the offsets cannot be named)" + cost;
  }
  const detail = addresses.map((entry) => (
    entry.lanes.length === 1
      ? `lane ${entry.lanes[0]} ${pattern.isRead ? "reads" : "writes"} ${formatAddr(entry.addr)}`
      : `lanes ${joinWithAnd(entry.lanes)} ${pattern.isRead ? "read" : "wrote"} ${formatAddr(entry.addr)}`
  )).join(", ");
  return `bank ${column.bank}: ${column.addrs} different ${plural(column.addrs, "address", "addresses")} ${where} — ${detail}${cost}`;
}

function conflictKeyOf(opcode: LdsOpcode, addr: number): number {
  return opcode.bytesPerAddr > 0 && opcode.bytesPerAddr < BANK_BYTES
    ? Math.floor(addr / BANK_BYTES) * BANK_BYTES
    : addr;
}

function bankOf(addr: number, bankCount: number = LDS_BANK_COUNT): number {
  return Math.trunc(addr / BANK_BYTES) % bankCount;
}

export function ldsBankAddresses(
  pattern: LdsPattern,
  phase: number,
  bank: number,
  bankCount: number = LDS_BANK_COUNT,
): LdsBankAddress[] {
  const opcode = ldsOpcode(pattern.name);
  const banksPerAddr = opcode.bytesPerAddr > 0 ? Math.ceil(opcode.bytesPerAddr / BANK_BYTES) : 1;
  const byKey = new Map<number, number[]>();
  for (const lane of pattern.lanes) {
    if (lane.phase !== phase) continue;
    for (const addr of lane.addrs) {
      const base = bankOf(addr, bankCount);
      for (let k = 0; k < banksPerAddr; k++) {
        if ((base + k) % bankCount !== bank) continue;
        const key = conflictKeyOf(opcode, addr);
        const lanesAt = byKey.get(key);
        if (lanesAt === undefined) byKey.set(key, [lane.lane]);
        else if (!lanesAt.includes(lane.lane)) lanesAt.push(lane.lane);
      }
    }
  }
  return Array.from(byKey, ([addr, lanes]) => ({ addr, lanes: lanes.sort((a, b) => a - b) }))
    .sort((left, right) => left.addr - right.addr);
}

// The busiest (phase, bank) pair, or null when no per-bank counts were reported.
// Scanned phase-major so the first maximum wins, which makes the sentence stable.
function ldsBusiestGroup(pattern: LdsPattern, bankCount: number = LDS_BANK_COUNT): LdsBankGroup | null {
  if (!ldsBankCountsReported(pattern)) return null;
  let best: LdsBankGroup | null = null;
  pattern.phases.forEach((phase, phaseIndex) => {
    const row = bankAddrsOf(phase);
    for (let bank = 0; bank < bankCount; bank++) {
      const addrs = row[bank] ?? 0;
      if (addrs <= 0 || (best !== null && addrs <= best.addrs)) continue;
      const lanes = ldsBankAddresses(pattern, phaseIndex, bank, bankCount);
      // Falls back to the wire's own bank field when the body carried no addresses. That
      // fallback can only see a *2 lane's PRIMARY bank, so it is a floor, not the group.
      const counted = lanes.length > 0
        ? new Set(lanes.flatMap((entry) => entry.lanes)).size
        : pattern.lanes.filter((lane) => lane.phase === phaseIndex && lane.bank === bank).length;
      best = { phase: phaseIndex, bank, addrs, lanes, laneCount: counted };
    }
  });
  return best;
}

function formatAddr(addr: number): string {
  return `0x${addr.toString(16)}`;
}

// One entry per address, naming the lanes at it. Lanes are joined with "and" because a
// reader is matching the list against the table, where "0, 2" reads as one item.
function describeGroup(pattern: LdsPattern, group: LdsBankGroup): string {
  const verb = pattern.isRead ? "read" : "wrote";
  const shown = group.lanes.slice(0, GROUP_DETAIL_LIMIT);
  const parts = shown.map((entry) => {
    // Capped like the addresses: a 64-lane broadcast would otherwise print 64 lane ids.
    const named = entry.lanes.slice(0, LANE_DETAIL_LIMIT);
    const extra = entry.lanes.length - named.length;
    const lanes = named.length === 1
      ? `lane ${named[0]}`
      : `lanes ${joinWithAnd(named)}${extra > 0 ? ` and ${extra} more` : ""}`;
    return `${lanes} ${verb} ${formatAddr(entry.addr)}`;
  });
  const rest = group.addrs - shown.length;
  const joined = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return rest > 0 ? `${joined}, and ${rest} more ${plural(rest, "address", "addresses")}` : joined;
}

// "0, 2 and 4". Two is "0 and 2", one is "0".
function joinWithAnd(items: number[]): string {
  if (items.length === 1) return String(items[0]);
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Phrased so the count is not confused for a per-row one: droppedExecutions counts
// accesses that never became a row.
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

// The LDS geometry, restated from the analyzer's own ldsbank package: the rule that
// produced the phases is not on the wire, and the rule is the whole explanation.
const BANK_BYTES = 4;
const ROW_BYTES = LDS_BANK_COUNT * BANK_BYTES;
// A phase is at most one row of banks wide however narrow the lanes are.
const PHASE_LANE_CEILING = LDS_BANK_COUNT;

export type LdsOpcode = {
  name: string;
  // known is false for a mnemonic outside the table below, so a caller can say the
  // phase width is not derivable rather than inventing one.
  known: boolean;
  isRead: boolean;
  bytesPerAddr: number;
  addrsPerLane: number;
  bytesPerLane: number;
  lanesPerPhase: number;
  // The width the 128-byte rule asks for before the ceiling applies. It differs only
  // for ds_write_b8, and ldsOpcodeSentence says so there.
  lanesPerPhaseByRow: number;
};

// The opcodes gfx803 dispatches, copied from the analyzer's accessTable rather than
// parsed from the mnemonic: a name is a label, the widths are what the degree rests on.
const OPCODES: Record<string, { isRead: boolean; bytesPerAddr: number; addrsPerLane: number }> = {
  ds_write_b32: { isRead: false, bytesPerAddr: 4, addrsPerLane: 1 },
  ds_write2_b32: { isRead: false, bytesPerAddr: 4, addrsPerLane: 2 },
  ds_write_b8: { isRead: false, bytesPerAddr: 1, addrsPerLane: 1 },
  ds_read_b32: { isRead: true, bytesPerAddr: 4, addrsPerLane: 1 },
  ds_read2_b32: { isRead: true, bytesPerAddr: 4, addrsPerLane: 2 },
  ds_write2_b64: { isRead: false, bytesPerAddr: 8, addrsPerLane: 2 },
  ds_read_b64: { isRead: true, bytesPerAddr: 8, addrsPerLane: 1 },
  ds_read2_b64: { isRead: true, bytesPerAddr: 8, addrsPerLane: 2 },
  ds_write_b128: { isRead: false, bytesPerAddr: 16, addrsPerLane: 1 },
  ds_read_b128: { isRead: true, bytesPerAddr: 16, addrsPerLane: 1 },
};

export function ldsOpcode(name: string): LdsOpcode {
  const entry = typeof name === "string" ? OPCODES[name] : undefined;
  if (entry === undefined) {
    return { name: typeof name === "string" ? name : "", known: false, isRead: false, bytesPerAddr: 0, addrsPerLane: 0, bytesPerLane: 0, lanesPerPhase: 0, lanesPerPhaseByRow: 0 };
  }
  const bytesPerLane = Math.max(1, entry.bytesPerAddr * entry.addrsPerLane);
  const byRow = Math.max(1, Math.floor(ROW_BYTES / bytesPerLane));
  return {
    name,
    known: true,
    isRead: entry.isRead,
    bytesPerAddr: entry.bytesPerAddr,
    addrsPerLane: entry.addrsPerLane,
    bytesPerLane,
    lanesPerPhase: Math.min(byRow, PHASE_LANE_CEILING),
    lanesPerPhaseByRow: byRow,
  };
}

export function ldsOpcodeSentence(pattern: LdsPattern): string {
  const opcode = ldsOpcode(pattern.name);
  if (!opcode.known) {
    return `${pattern.name || "This opcode"} has no footprint in this analyzer's opcode table, so its phase width cannot be derived here; the phases below are the ones the analyzer recorded.`;
  }
  const laneCount = ldsLaneCount(pattern);
  const width = opcode.lanesPerPhaseByRow > opcode.lanesPerPhase
    ? `${ROW_BYTES} / ${opcode.bytesPerLane} asks for ${opcode.lanesPerPhaseByRow} lanes, capped at ${opcode.lanesPerPhase} because a phase is at most one ${LDS_BANK_COUNT}-bank row`
    : `${ROW_BYTES} / ${opcode.bytesPerLane} = ${opcode.lanesPerPhase} lanes`;
  return `A phase is one ${ROW_BYTES}-byte bank row, so it serves ${width} at a time. `
    + `Lanes in different phases are never in flight at the same time, so two lanes sharing a bank in different phases is not a conflict.`;
}

export const LDS_LIST_COLUMNS = [
  {
    key: "degree",
    label: "Degree",
    help: `The bank-conflict degree: the most distinct addresses one LDS bank held within a single phase. 1 is conflict-free. 4 means that bank held 4 different addresses at once, so the hardware served it in 4 cycles instead of one. The badge colour is the severity band, not a second measurement.`,
  },
  {
    key: "name",
    label: "Instruction",
    help: `The LDS opcode the emulator decoded for this access, e.g. ds_read2_b32 is a shared-memory read of two consecutive 32-bit words per lane. Hover a row for the full footprint and the phase width it implies.`,
  },
  {
    key: "stride",
    label: "Stride",
    help: `The byte step between consecutive lanes in the access's first phase. One bank row is 128 B and one bank is 4 B, so a 128 B stride puts every lane of a phase in the same bank (the worst case), while a stride that is odd in 4-byte words spreads the lanes across banks.`,
  },
  {
    key: "pc",
    label: "pc",
    help: `The access's offset within the kernel's own code — the address a disassembly is indexed by, so it names one instruction and is the same in every run. Select a row whose line is known and this becomes a jump to the source line the line table attributes it to. The attribution is the compiler's, at -O2: an access can be charged to the statement it came from even where the code was folded, so treat it as provenance rather than as a line to read for the access itself.`,
  },
  {
    key: "count",
    label: "Runs",
    help: `How many times this access pattern executed during the run. Patterns with the same opcode and the same per-phase degrees are grouped into one row however many times they ran.`,
  },
] as const;

export function ldsPatternSource(pattern: LdsPattern): { file: string; line: number } | null {
  const line = pattern.sourceLine;
  // Number.isFinite, so a pattern built without the fields at all -- undefined -- is the
  // "no line" case rather than a jump to a line that does not exist.
  if (!Number.isFinite(line) || Math.trunc(line) < 1) return null;
  if (typeof pattern.sourceFile !== "string" || pattern.sourceFile === "") return null;
  return { file: pattern.sourceFile, line: Math.trunc(line) };
}

export function ldsPcLabel(pattern: LdsPattern): string {
  const source = ldsPatternSource(pattern);
  const address = `pc 0x${pattern.pc.toString(16)}`;
  return source === null ? address : `${address} · ${source.file}:${source.line}`;
}

export function ldsSeverityLegend(): { color: string; label: string }[] {
  const bands = ldsSeverityBands();
  return bands.map((band, index) => {
    const next = bands[index + 1];
    const label = band.from === 1
      ? "1-way · no conflict"
      : next === undefined
        ? `${band.from}-way and worse`
        : `${band.from}–${next.from - 1}-way`;
    return { color: band.color, label };
  });
}

// The list above the map is a set of patterns, not of executions, worst conflict first.
export function ldsListNote(model: LdsModel): string {
  const count = model.patterns.length;
  return `${count} distinct ${plural(count, "access pattern")}, worst degree first. One row is one instruction's address pattern, not one execution — select a row for its bank map.`;
}

export function ldsRowTooltip(pattern: LdsPattern): string {
  const stride = pattern.uniformStride
    ? `a uniform ${pattern.stride}-byte stride`
    : pattern.stride === 0
      ? "no measurable stride"
      : `a ${pattern.stride}-byte stride in the first phase, which is not uniform across it`;
  const ran = `${pattern.count} ${plural(pattern.count, "time")}`;
  const source = ldsPatternSource(pattern);
  const from = source === null
    ? "This code object carried no line table, so there is no source line to jump to."
    : `Attributed by the code object's line table to ${source.file} line ${source.line} — click the pc to jump there.`;
  return `${pattern.name} at pc 0x${pattern.pc.toString(16)}, ${pattern.isRead ? "a read" : "a write"} that ran ${ran}: degree ${pattern.degree}, ${stride}. ${from} ${ldsOpcodeSentence(pattern)}`;
}

export function ldsBankInfoNote(): string {
  return `The LDS is ${LDS_BANK_COUNT} banks of ${BANK_BYTES} B — one ${ROW_BYTES}-byte row. `
    + `Bank = (byte address / ${BANK_BYTES}) mod ${LDS_BANK_COUNT}. `
    + `A bank is ${BANK_BYTES} B wide and retires one address per cycle, so a bank holding N different addresses costs N cycles, while N lanes holding one address cost one. `
    + `Lanes are served in phases of one ${ROW_BYTES}-byte row, and only lanes in the same phase can collide.`;
}

export function ldsBankMapNote(): string {
  return `Each column is one bank, and its height is how many different addresses that bank saw in this access's busiest phase — not how many lanes reached it, since lanes reading one address cost one cycle however many there are. `
    + `A red column held more than one address, so it could not be served in a single cycle; the number on top is how many, which is the phase's degree. `
    + `A grey column held at most one address and is free. The coloured strip under the axis splits the lanes into phases.`;
}

export function ldsPhaseStripNote(pattern: LdsPattern): string {
  if (pattern.phases.length === 0) return "No phases were recorded for this access, so the strip under the axis is empty.";
  const cycles = pattern.phases.reduce((total, phase) => total + Math.max(1, phase.degree), 0);
  if (pattern.phases.length === 1) {
    return `One phase, so the whole wave is served in one go and the access costs ${cycles} ${plural(cycles, "cycle")}.`;
  }
  const degrees = pattern.phases.map((phase) => Math.max(1, phase.degree)).join(" + ");
  return `${pattern.phases.length} phases, each served separately with its own degree, so this access costs ${degrees} = ${cycles} cycles. A lane only collides with lanes in its own phase, so the degrees add up rather than the worst one being paid ${pattern.phases.length} times.`;
}

export function ldsPhaseBankKey(phase: number, bank: number): string {
  return `${phase}/${bank}`;
}

export function ldsPhaseBankLanes(pattern: LdsPattern, bankCount: number = LDS_BANK_COUNT): Map<string, LdsLane[]> {
  const grouped = new Map<string, LdsLane[]>();
  for (const lane of pattern.lanes) {
    if (!Number.isInteger(lane.bank) || lane.bank < 0 || lane.bank >= bankCount) continue;
    const key = ldsPhaseBankKey(lane.phase, lane.bank);
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [lane]);
    else bucket.push(lane);
  }
  return grouped;
}

export function ldsLaneBankAddrs(pattern: LdsPattern, lane: LdsLane): number | null {
  if (!Number.isInteger(lane.phase) || lane.phase < 0 || lane.phase >= pattern.phases.length) return null;
  return bankAddrsOf(pattern.phases[lane.phase])[lane.bank] ?? 0;
}

export function ldsLaneTableNote(pattern: LdsPattern): string {
  const rows = pattern.lanes.length;
  return `One row per active lane (${rows} here). Address is the lane's byte offset into shared memory, and Bank is (address / ${BANK_BYTES}) mod ${LDS_BANK_COUNT}. `
    + `"Other lanes in this bank" lists only lanes in this row's own phase, because those are the only ones the hardware has in flight with it — lanes sharing the bank in another phase cannot collide with it. `
    + `"Addresses in this bank" is what decides the cost: one address is free however many lanes read it, and each extra address is one more cycle.`;
}

export const LDS_LANE_COLUMNS = [
  {
    key: "lane",
    label: "Lane",
    help: `The lane id inside the wave64. A GCN3 wave is 64 lanes wide and executes one instruction at a time.`,
  },
  {
    key: "addr",
    label: "Address",
    help: `The lane's byte offset into shared memory. Divide it by 4 and take the result mod 32 to get the bank — the GCN3 rule. A *2 opcode such as ds_read2_b32 moves two addresses per lane, so its row lists both.`,
  },
  {
    key: "bytes",
    label: "Bytes",
    help: `How many bytes this lane moves per access, from the opcode's footprint: 4 for ds_read_b32, 8 for ds_read2_b32, and so on. A bank retires one 4 B address per cycle, so this is also what makes a 128-bit lane span four banks.`,
  },
  {
    key: "bank",
    label: "Bank",
    help: `Which of the 32 banks this lane's address falls in. A red row means the bank saw more than one address in this lane's phase, which is what costs the extra cycles.`,
  },
  {
    key: "phase",
    label: "Phase",
    help: `The group of lanes the hardware serves together, one 128-byte bank row at a time. Lanes in different phases are never in flight at the same time, so only lanes in one phase can collide.`,
  },
  {
    key: "peers",
    label: "Other lanes in this bank",
    help: `The other lanes in this bank inside this lane's own phase — the only ones that can collide with this row. Lanes sharing the bank in other phases are not listed, because the hardware is not holding them at the same time. Several lanes listed here is only a problem if they sit at different addresses, which is what the last column counts.`,
  },
  {
    key: "addrs",
    label: "Addresses in this bank",
    help: `How many distinct addresses this bank saw in this phase. One address is a broadcast or a lone lane and is free; more than one is the degree, and each extra address is one more cycle.`,
  },
] as const;

export function ldsLanePeersLabel(peers: number[]): string {
  if (peers.length === 0) return "none — alone in this bank";
  return `lanes ${peers.join(", ")}`;
}

export function ldsLaneAddrLabel(lane: LdsLane): string {
  if (lane.addrs.length === 0) return "not reported";
  return lane.addrs.map(formatAddr).join(", ");
}

export function ldsLaneBytes(pattern: LdsPattern): number {
  return ldsOpcode(pattern.name).bytesPerLane;
}
