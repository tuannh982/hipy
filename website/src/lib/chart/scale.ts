
import { max } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import type { ScaleBand } from "d3-scale";

export { scaleBand, scaleLinear };

export function barScale(maximum: number, height: number, niceCount = 4): (value: number) => number {
  const scale = scaleLinear().domain([0, Math.max(0, maximum)]).range([height, 0]).nice(niceCount);
  return (value: number): number => scale(value);
}

export function categoryScale(count: number, width: number, innerPadding = 0): ScaleBand<number> {
  return scaleBand<number>()
    .domain(d3Range(count))
    .range([0, width])
    .paddingInner(innerPadding);
}

function d3Range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

export function linearTicks(
  scale: (value: number) => number,
  domain: readonly [number, number],
  count: number,
  format: (value: number) => string,
): { value: number; at: number; label: string }[] {
  const [low, high] = domain;
  const step = (high - low) / Math.max(1, count);
  return Array.from({ length: count + 1 }, (_, index) => {
    const value = low + step * index;
    return { value, at: scale(value), label: format(value) };
  });
}

export function peak(values: readonly (number | undefined)[]): number {
  const top = max(values, (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined));
  return top === undefined ? 0 : top;
}

export function headroom(maximum: number, fraction = 0.1): readonly [number, number] {
  return [0, maximum > 0 ? maximum * (1 + fraction) : 1];
}
