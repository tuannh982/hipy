
export const PS_PER_NS = 1_000;
export const PS_PER_US = 1_000_000;
export const PS_PER_MS = 1_000_000_000;

export type TimeUnit = {
    divisor: number;
    name: string;
    short: string;
};

const NANOSECOND: TimeUnit = { divisor: PS_PER_NS, name: "nanoseconds", short: "ns" };
const MICROSECOND: TimeUnit = { divisor: PS_PER_US, name: "microseconds", short: "µs" };
const MILLISECOND: TimeUnit = { divisor: PS_PER_MS, name: "milliseconds", short: "ms" };

export function timeUnitFor(spanPs: number): TimeUnit {
  const span = Math.abs(spanPs);
  if (span < PS_PER_US) return NANOSECOND;
  if (span < PS_PER_MS) return MICROSECOND;
  return MILLISECOND;
}

export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function decimalsFor(step: number): number {
  if (!(step > 0)) return 0;
  if (step >= 1) return 0;
  return Math.min(4, Math.max(1, Math.ceil(-Math.log10(step))));
}

export function formatTime(valuePs: number, unit: TimeUnit, stepPs: number): string {
  const scaled = valuePs / unit.divisor;
  let decimals = decimalsFor(stepPs / unit.divisor);
          if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    decimals = Math.min(3, decimals + 1);
  }
  const text = scaled.toFixed(decimals);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

export type TimeTick = {
    timePs: number;
    label: string;
};

export type TimeAxis = {
  unit: TimeUnit;
    ticks: TimeTick[];
    title: string;
    fromPs: number;
  toPs: number;
};

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
                let time = Math.ceil(from / step) * step;
    for (let drawn = 0; drawn < 1000 && time <= to + step * 1e-6; drawn++) {
      ticks.push({ timePs: time, label: formatTime(time, unit, step) });
      time += step;
    }
  }
  return { unit, ticks, title, fromPs: from, toPs: to };
}
