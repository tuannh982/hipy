// Scales and ticks, shared by every chart in the app.
//
// d3 computes the geometry; React renders it. No d3-selection and no imperative
// DOM: a scale is a pure function from a data value to a pixel.
//
// Every chart derives its scales here rather than inlining them, so "a stacked bar"
// and "a time series" cannot each invent their own idea of a domain.

import { max } from "d3-array";
import { scaleBand, scaleLinear } from "d3-scale";
import type { ScaleBand } from "d3-scale";

export { scaleBand, scaleLinear };

/**
 * A linear scale whose domain starts at zero and ends at a whole number above the
 * data's maximum.
 *
 * Zero is not a default, it is the rule: a bar chart whose baseline is not zero lies
 * about its ratios. `niceCount` goes to d3's `nice`, so the tallest bar does not
 * touch the frame.
 */
export function barScale(maximum: number, height: number, niceCount = 4): (value: number) => number {
  const scale = scaleLinear().domain([0, Math.max(0, maximum)]).range([height, 0]).nice(niceCount);
  return (value: number): number => scale(value);
}

/**
 * A band scale over a fixed set of categories, with no outer padding.
 *
 * The CPI stack and the bank map are both category axes where the categories touch:
 * a stacked bar's segments are contiguous, and a bank map's columns are adjacent
 * banks.
 */
export function categoryScale(count: number, width: number, innerPadding = 0): ScaleBand<number> {
  return scaleBand<number>()
    .domain(d3Range(count))
    .range([0, width])
    .paddingInner(innerPadding);
}

function d3Range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/**
 * Ticks for a linear scale, as `[value, label]` pairs.
 *
 * d3 picks the round numbers. `format` is required rather than optional: an axis
 * whose labels carry no unit is a number a reader has to guess the dimension of.
 */
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

/**
 * The largest value in `values`, or 0 when there are none.
 *
 * d3's `max` skips NaN and undefined, which is what a series with gaps needs, and
 * returns undefined for an empty series -- collapsed to 0 here rather than letting
 * `undefined` produce a scale that maps everything to NaN.
 */
export function peak(values: readonly (number | undefined)[]): number {
  const top = max(values, (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined));
  return top === undefined ? 0 : top;
}

/**
 * A domain whose upper end is above `maximum`, so a line's peak is inside the
 * frame rather than on its edge.
 *
 * Only for lines. Bars are read against the baseline, and headroom on a bar is a
 * shorter bar.
 */
export function headroom(maximum: number, fraction = 0.1): readonly [number, number] {
  return [0, maximum > 0 ? maximum * (1 + fraction) : 1];
}