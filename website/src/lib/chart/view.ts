// Zoom, pan and range selection, as arithmetic on a window over sample indices.
//
// Separate from the component because this is the part that can be wrong in ways a
// screenshot cannot show: a chart that zooms to the wrong window still looks like a
// chart.
//
// The window is over sample INDICES and the axis is SIMULATED TIME. A contiguous run
// of samples is already a contiguous run of time, so a window of [12, 40) means both
// "samples 12 through 39" and "the time from t[12] to t[39]" without either being
// restated. Independent of how many samples arrive later, which is what lets a live
// chart keep its zoom while new samples stream in behind it.

/** An inclusive-exclusive window of sample indices. */
export type View = {
  from: number;
  /** Exclusive, so `to - from` is the count. */
  to: number;
};

/**
 * One simulated time per point of a series, in picoseconds.
 *
 * Indexed by the SERIES' OWN point number, not by the sample number. The two differ
 * wherever a series is a rate between consecutive samples: a rate series has one
 * fewer point than there are samples, and its point i describes the interval ending
 * at sample i+1, so its times are the samples' times shifted by one. See
 * seriesTimes in ../dashboard.ts, which is the one place that slices.
 *
 * Non-decreasing, and possibly not strictly so: two samples can share a sim time,
 * and a repeated time is drawn as one point.
 */
export type SampleTimes = readonly number[];

/** The smallest window the controls will produce. Below this a chart has no shape. */
export const MIN_WINDOW = 8;

/** Never zoom past this many times the full range. */
export const MAX_ZOOM = 64;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Constrain a window to what the data allows.
 *
 * Three things, in order: the count cannot go below MIN_WINDOW, the window cannot run
 * off either end, and a count below the minimum is widened rather than rejected --
 * which is why `sampleCount` is a parameter, since a chart with three samples still
 * has to draw.
 */
export function clampView(view: View, sampleCount: number): View {
  if (sampleCount <= 0) return { from: 0, to: 0 };
  const smallest = Math.min(MIN_WINDOW, sampleCount);
  let span = clamp(view.to - view.from, smallest, sampleCount);
  let from = clamp(view.from, 0, sampleCount - span);
  return { from, to: from + span };
}

/** The window covering everything. */
export function fullView(sampleCount: number): View {
  return { from: 0, to: Math.max(0, sampleCount) };
}

/** True when the window is not showing everything. */
export function isZoomed(view: View, sampleCount: number): boolean {
  return view.from > 0 || view.to < sampleCount;
}

/**
 * Zoom by `factor`, keeping the sample under `anchor` (a 0..1 fraction of the plot's
 * width) in place.
 *
 * The anchor is what makes wheel zoom usable: zooming about the window's centre means
 * the number under the cursor always slides out from under it, and on a live chart it
 * also means the window drifts.
 *
 * `factor` above 1 zooms IN, the opposite of the usual scale-factor convention.
 */
export function zoomAbout(view: View, sampleCount: number, anchor: number, factor: number): View {
  const current = clampView(view, sampleCount);
  const span = current.to - current.from;
  const anchorFraction = clamp(anchor, 0, 1);
  const anchorIndex = current.from + span * anchorFraction;

  const widest = Math.min(sampleCount, span * MAX_ZOOM);
  const smallest = Math.min(MIN_WINDOW, sampleCount);
  const nextSpan = clamp(span * factor, smallest, widest);
  if (nextSpan === span) return current;

  return clampView(
    { from: anchorIndex - nextSpan * anchorFraction, to: anchorIndex + nextSpan * (1 - anchorFraction) },
    sampleCount,
  );
}

/**
 * Pan by a fraction of the window's own width.
 *
 * Scaled by the span rather than a fixed number of samples, so one drag moves the
 * same visual distance whether the window is 20 samples or 200.
 */
export function panBy(view: View, sampleCount: number, deltaFraction: number): View {
  const current = clampView(view, sampleCount);
  const span = current.to - current.from;
  const shift = span * deltaFraction;
  return clampView({ from: current.from + shift, to: current.to + shift }, sampleCount);
}

/**
 * The simulated time of one point, defensively.
 *
 * Clamped into the window's own range and tolerant of a `times` array shorter than
 * the series. A missing time falls back to the window's first, which collapses the
 * offending points together rather than putting them at NaN.
 */
function timeAt(index: number, low: number, high: number, times: SampleTimes): number {
  const clamped = clamp(Math.round(index), low, high);
  const time = times[clamped];
  return typeof time === "number" && Number.isFinite(time) ? time : (times[low] ?? 0);
}

/** The time the window covers, in picoseconds. Zero when every point shares a time. */
export function windowSpanPs(view: View, sampleCount: number, times: SampleTimes): number {
  const current = clampView(view, sampleCount);
  const high = current.to - 1;
  return timeAt(high, current.from, high, times) - timeAt(current.from, current.from, high, times);
}

/**
 * The point nearest a pointer position, chosen by TIME.
 *
 * Nearest by index would be wrong on a time axis: with unevenly spaced
 * samples, a pointer in the wide gap between two of them has a definite answer in
 * time terms. A tie goes to the LATER point, the one drawn on top of the two.
 *
 * Clamped to the window, so a pointer dragged past either edge reports the edge
 * rather than a point that is not drawn.
 */
export function indexAt(
  view: View,
  sampleCount: number,
  fraction: number,
  times: SampleTimes,
): number {
  const current = clampView(view, sampleCount);
  if (current.to - current.from <= 0) return current.from;
  const high = current.to - 1;
  const from = timeAt(current.from, current.from, high, times);
  const to = timeAt(high, current.from, high, times);
  const span = to - from;
  if (span <= 0) return current.from;
  const target = from + clamp(fraction, 0, 1) * span;

  let nearest = current.from;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = current.from; index < current.to; index++) {
    const distance = Math.abs(timeAt(index, current.from, high, times) - target);
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  }
  return nearest;
}

/**
 * A 0..1 fraction of the window's width at which a point sits.
 *
 * The inverse of indexAt, which is why the two disagree on unevenly spaced data: the
 * crosshair goes where the pointer is in TIME, and the dot it finds is the nearest
 * point in time.
 */
export function fractionOf(
  view: View,
  sampleCount: number,
  index: number,
  times: SampleTimes,
): number {
  const current = clampView(view, sampleCount);
  const high = current.to - 1;
  const from = timeAt(current.from, current.from, high, times);
  const to = timeAt(high, current.from, high, times);
  const span = to - from;
  if (span <= 0) return 0;
  return clamp((timeAt(index, current.from, high, times) - from) / span, 0, 1);
}

/**
 * Zoom to a range the pointer dragged out, resolved in time.
 *
 * Returns the FULL view unchanged when the drag was too small to be a range: a click
 * with no movement must not zoom to a one-point window, and must not be a no-op the
 * reader has to puzzle out either. Six pixels is the threshold because below it a
 * shaky click reads as a drag. A right-to-left drag selects the same range.
 *
 * The dragged edges are converted to TIMES and then snapped to the points they fall
 * among, because between unevenly spaced points there is no exact match for a pixel.
 * The low end is anchored and the high end clipped to the data rather than letting
 * clampView slide the window to fit: a drag out past the right edge asked to SEE that
 * region, and sliding leftwards would show less of what was pointed at.
 */
export function selectRange(
  view: View,
  sampleCount: number,
  anchorFraction: number,
  releaseFraction: number,
  draggedPixels: number,
  plotWidth: number,
  times: SampleTimes,
): View {
  if (plotWidth <= 0 || draggedPixels < 6) return clampView(view, sampleCount);
  const current = clampView(view, sampleCount);
  if (current.to - current.from <= 1) return current;
  const high = current.to - 1;
  const from = timeAt(current.from, current.from, high, times);
  const to = timeAt(high, current.from, high, times);
  const span = to - from;
  if (span <= 0) return current;

  const low = from + span * clamp(Math.min(anchorFraction, releaseFraction), 0, 1);
  const highTime = from + span * clamp(Math.max(anchorFraction, releaseFraction), 0, 1);

  let newFrom = current.from;
  for (let index = current.from; index < current.to; index++) {
    if (timeAt(index, current.from, high, times) >= low) {
      newFrom = index;
      break;
    }
  }
  let newTo = newFrom + 1;
  for (let index = high; index >= current.from; index--) {
    if (timeAt(index, current.from, high, times) <= highTime) {
      newTo = index + 1;
      break;
    }
  }

  const boundedFrom = clamp(newFrom, 0, Math.max(0, sampleCount - 1));
  const boundedTo = clamp(newTo, boundedFrom + 1, sampleCount);
  return clampView({ from: boundedFrom, to: boundedTo }, sampleCount);
}
