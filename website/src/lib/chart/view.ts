
export type View = {
  from: number;
    to: number;
};

export type SampleTimes = readonly number[];

export const MIN_WINDOW = 8;

export const MAX_ZOOM = 64;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function clampView(view: View, sampleCount: number): View {
  if (sampleCount <= 0) return { from: 0, to: 0 };
  const smallest = Math.min(MIN_WINDOW, sampleCount);
  let span = clamp(view.to - view.from, smallest, sampleCount);
  let from = clamp(view.from, 0, sampleCount - span);
  return { from, to: from + span };
}

export function fullView(sampleCount: number): View {
  return { from: 0, to: Math.max(0, sampleCount) };
}

export function isZoomed(view: View, sampleCount: number): boolean {
  return view.from > 0 || view.to < sampleCount;
}

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

export function panBy(view: View, sampleCount: number, deltaFraction: number): View {
  const current = clampView(view, sampleCount);
  const span = current.to - current.from;
  const shift = span * deltaFraction;
  return clampView({ from: current.from + shift, to: current.to + shift }, sampleCount);
}

function timeAt(index: number, low: number, high: number, times: SampleTimes): number {
  const clamped = clamp(Math.round(index), low, high);
  const time = times[clamped];
  return typeof time === "number" && Number.isFinite(time) ? time : (times[low] ?? 0);
}

export function windowSpanPs(view: View, sampleCount: number, times: SampleTimes): number {
  const current = clampView(view, sampleCount);
  const high = current.to - 1;
  return timeAt(high, current.from, high, times) - timeAt(current.from, current.from, high, times);
}

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
