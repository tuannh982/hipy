// Simulated time as axis ticks: which unit to show, and where to put the marks.
//
// A unit that renders a 25 us run as "25000000" looks entirely reasonable on screen
// and is unreadable in practice, and nothing in a screenshot distinguishes that from
// a correct axis.
//
// The unit follows the WINDOW, not the run, so zooming in earns precision: a window
// covering 400 ns labels in nanoseconds, and the full run of the same kernel labels
// in milliseconds. That is the finest unit in which the visible span is still a
// readable number, and no finer.

/** Picoseconds per unit. The wire format is picoseconds throughout. */
export const PS_PER_NS = 1_000;
export const PS_PER_US = 1_000_000;
export const PS_PER_MS = 1_000_000_000;

export type TimeUnit = {
  /** Divide picoseconds by this to get the displayed number. */
  divisor: number;
  /** Spelled out for the axis title, where there is room for words. */
  name: string;
  /** Abbreviated, for a cursor readout where the axis title is not adjacent. */
  short: string;
};

const NANOSECOND: TimeUnit = { divisor: PS_PER_NS, name: "nanoseconds", short: "ns" };
const MICROSECOND: TimeUnit = { divisor: PS_PER_US, name: "microseconds", short: "µs" };
const MILLISECOND: TimeUnit = { divisor: PS_PER_MS, name: "milliseconds", short: "ms" };

/**
 * The unit that renders `spanPs` as a number of at least 1.
 *
 * Boundaries at 1 µs and 1 ms rather than at powers of a thousand within each unit,
 * so a span is never labelled "0.4 ms" when "400 µs" says the same in three
 * characters.
 */
export function timeUnitFor(spanPs: number): TimeUnit {
  const span = Math.abs(spanPs);
  if (span < PS_PER_US) return NANOSECOND;
  if (span < PS_PER_MS) return MICROSECOND;
  return MILLISECOND;
}

/**
 * A round step at or above `raw`, of the form 1, 2 or 5 times a power of ten.
 *
 * Not 1/2/5/10: 2.5 × 10ⁿ produces labels that differ in the last digit only, which
 * is unreadable at tick-label size.
 */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Decimal places that render `step` with between one and four significant figures. */
function decimalsFor(step: number): number {
  if (!(step > 0)) return 0;
  if (step >= 1) return 0;
  return Math.min(4, Math.max(1, Math.ceil(-Math.log10(step))));
}

/** A time as a tick label: scaled, at a precision the step justifies, no trailing zeros. */
export function formatTime(valuePs: number, unit: TimeUnit, stepPs: number): string {
  const scaled = valuePs / unit.divisor;
  let decimals = decimalsFor(stepPs / unit.divisor);
  // A tick is a multiple of its step, so decimalsFor is the right precision for one
  // -- but this also renders an ARBITRARY time for the cursor readout, and rounding
  // 2.5us to "3" there puts the readout at the wrong moment. So a value with a
  // fractional part gets one more digit.
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    decimals = Math.min(3, decimals + 1);
  }
  const text = scaled.toFixed(decimals);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

export type TimeTick = {
  /** Where the mark is, in picoseconds, for positioning. */
  timePs: number;
  /** What to print under it. */
  label: string;
};

export type TimeAxis = {
  unit: TimeUnit;
  /** The marks, ascending. Empty only when the window has no measurable span. */
  ticks: TimeTick[];
  /** The axis title, naming the unit in words rather than on every tick. */
  title: string;
  /** The window's own ends, for a readout that has to name the range. */
  fromPs: number;
  toPs: number;
};

/**
 * The x axis for a window covering `fromPs` to `toPs`.
 *
 * Marks land on round multiples of the step rather than on the window's own ends,
 * because the ends are arbitrary numbers and labelling a time axis with arbitrary
 * values on both ends is how it ends up unreadable. Round marks also stay put as the
 * window is panned.
 */
export function timeAxis(fromPs: number, toPs: number, wanted: number): TimeAxis {
  const from = Math.min(fromPs, toPs);
  const to = Math.max(fromPs, toPs);
  const unit = timeUnitFor(to - from);
  const title = `Simulated time (${unit.short})`;

  const span = to - from;
  if (!(span > 0)) {
    return {
      unit,
      ticks: [{ timePs: from, label: formatTime(from, unit, 0) }],
      title,
      fromPs: from,
      toPs: to,
    };
  }

  const step = niceStep(span / Math.max(1, wanted));
  const ticks: TimeTick[] = [];
  if (step > 0) {
    // Ceil rather than round, so the first mark is inside the window rather than one
    // step before it. The loop guard stops a step that underflows to zero from
    // spinning forever.
    let time = Math.ceil(from / step) * step;
    for (let drawn = 0; drawn < 1000 && time <= to + step * 1e-6; drawn++) {
      ticks.push({ timePs: time, label: formatTime(time, unit, step) });
      time += step;
    }
  }
  return { unit, ticks, title, fromPs: from, toPs: to };
}