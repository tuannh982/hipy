// Zoom, pan and range selection.
//
// This arithmetic is separated from the component precisely because it can be
// wrong in a way a screenshot cannot show. A chart that zooms to the wrong window,
// or pans the wrong way, or reports the wrong sample under the crosshair, still
// looks like a chart. The failure is that the number under the label is not the
// number under the cursor, and nobody notices until they trust it.
//
// The window is still defined over sample INDICES -- a contiguous run of samples is
// a contiguous run of time -- so the zoom and pan arithmetic below is unchanged and
// is tested exactly as before. What is new is everything that converts between a
// screen position and a data point, which now has to go by TIME, and an evenly
// spaced fixture would let all of that pass against the old index arithmetic. So the
// new tests run on deliberately ragged spacing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const view = await tsImport(path.join(repoRoot, "website", "src", "lib", "chart", "view.ts"), import.meta.url);
const timeAxis = await tsImport(path.join(repoRoot, "website", "src", "lib", "chart", "timeAxis.ts"), import.meta.url);

const N = 160;

/** Evenly spaced, so index arithmetic and time arithmetic agree. */
const even = (n) => Array.from({ length: n }, (_, i) => i * 1_000_000);

/**
 * Unevenly spaced, on purpose.
 *
 * The stream paces on "every 256 retired instructions, at least 40ms apart", so
 * consecutive samples are not a fixed distance apart -- measured gaps on one run
 * were 1ms, 8ms, 15ms and 22ms repeating. Every test below that would pass against
 * the old index arithmetic uses this rather than `even`, because with even spacing
 * the two are the same function and the test proves nothing.
 */
const ragged = (n) => {
  const times = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    times.push(t);
    t += 1_000_000 + (i % 4) * 7_000_000;
  }
  return times;
};

test("the full view covers everything and is not zoomed", () => {
  const full = view.fullView(N);
  assert.deepEqual(full, { from: 0, to: N });
  assert.equal(view.isZoomed(full, N), false);
});

test("a zoomed view says so, and a shifted one does too", () => {
  assert.equal(view.isZoomed({ from: 10, to: 50 }, N), true);
  // A window at the right-hand end is still a window, even though from is 0.
  assert.equal(view.isZoomed({ from: 0, to: 40 }, N), true);
});

test("zooming in about the cursor keeps the sample under it in place", () => {
  // THE reason zoom takes an anchor. Zooming about the centre slides the value
  // under the pointer out from under it, so reading a number while zooming is
  // impossible -- and on a live chart, where samples keep arriving, the window
  // drifts as well.
  const before = view.fullView(N);
  const anchor = 0.25;
  const anchorIndex = before.from + (before.to - before.from) * anchor;
  const after = view.zoomAbout(before, N, anchor, 1 / 1.5);

  assert.ok(after.to - after.from < N, "the window did not shrink");
  const afterIndex = after.from + (after.to - after.from) * anchor;
  // Within a sample: the window is quantised to whole indices.
  assert.ok(Math.abs(afterIndex - anchorIndex) <= 1, `anchor moved from ${anchorIndex} to ${afterIndex}`);
});

test("zooming out about the cursor is the inverse of zooming in", () => {
  const start = view.fullView(N);
  const inward = view.zoomAbout(start, N, 0.5, 0.5);
  const outward = view.zoomAbout(inward, N, 0.5, 2);
  assert.deepEqual(outward, start, "zoom out did not return to the full range");
});

test("zoom clamps to a floor and a ceiling", () => {
  // Down: never below MIN_WINDOW, or the chart has no shape left to read.
  let view_ = view.fullView(N);
  for (let i = 0; i < 40; i++) view_ = view.zoomAbout(view_, N, 0.5, 0.5);
  assert.equal(view_.to - view_.from, view.MIN_WINDOW);

  // Up: never past the data, and never past MAX_ZOOM times the original span.
  let out = view.fullView(N);
  for (let i = 0; i < 40; i++) out = view.zoomAbout(out, N, 0.5, 2);
  assert.ok(out.to - out.from <= N, "the window grew past the data");
  assert.ok(out.to - out.from <= N * view.MAX_ZOOM);
});

test("a window never runs off either end, whichever way it is anchored", () => {
  // Zooming in hard with the cursor at the far left, and again at the far right.
  const left = view.zoomAbout(view.fullView(N), N, 0, 0.2);
  assert.ok(left.from >= 0, `from ${left.from}`);
  assert.ok(left.to <= N, `to ${left.to}`);

  const right = view.zoomAbout(view.fullView(N), N, 1, 0.2);
  assert.ok(right.from >= 0, `from ${right.from}`);
  assert.ok(right.to <= N, `to ${right.to}`);
});

test("panning right moves the window right", () => {
  // A sign error here is invisible in a screenshot and makes the control feel
  // broken, so it is asserted directly. A quarter of a 40-sample window is 10
  // samples, not 20 -- the shift scales with the span.
  const start = { from: 40, to: 80 };
  const panned = view.panBy(start, N, 0.25);
  assert.equal(panned.from, 50);
  assert.equal(panned.to, 90);
});

test("panning past either end stops at the end rather than running off", () => {
  assert.deepEqual(view.panBy({ from: 0, to: 40 }, N, -1), { from: 0, to: 40 });
  assert.deepEqual(view.panBy({ from: 120, to: 160 }, N, 1), { from: 120, to: 160 });
});

test("pan distance scales with the window, so a drag feels the same at any zoom", () => {
  // A pan in SAMPLES would move half the screen at one zoom and a pixel at
  // another. Scaled by the span, one drag is one gesture everywhere.
  const narrow = view.panBy({ from: 0, to: 20 }, N, 0.25);
  const wide = view.panBy({ from: 0, to: 120 }, N, 0.25);
  assert.equal(narrow.to - narrow.from, 20);
  assert.equal(wide.to - wide.from, 120);
  assert.equal(narrow.to - narrow.from, 20);
});

test("a drag selects the range between the two points", () => {
  const start = view.fullView(N);
  const chosen = view.selectRange(start, N, 0.25, 0.75, 250, 500, even(N));
  assert.equal(chosen.from, 40);
  assert.equal(chosen.to, 120);
});

test("a drag right-to-left selects the same range", () => {
  // Nobody expects a backwards drag to zoom out instead.
  const start = view.fullView(N);
  const forward = view.selectRange(start, N, 0.25, 0.75, 250, 500, even(N));
  const backward = view.selectRange(start, N, 0.75, 0.25, 250, 500, even(N));
  assert.deepEqual(backward, forward);
});

test("a click is not a range selection", () => {
  // Under six pixels is a shaky click, and zooming to a one-sample window on a
  // mis-click would be worse than doing nothing.
  const start = view.fullView(N);
  assert.deepEqual(view.selectRange(start, N, 0.5, 0.5, 2, 500, even(N)), start);
  assert.deepEqual(view.selectRange(start, N, 0.1, 0.9, 0, 500, even(N)), start);
});

test("a drag selection is clamped to the data", () => {
  // Dragging past the end of a window that is already zoomed must not produce a
  // window outside it.
  const start = { from: 100, to: 140 };
  const chosen = view.selectRange(start, N, 0.9, 3, 400, 500, even(N));
  assert.ok(chosen.from >= start.from, `from ${chosen.from}`);
  assert.ok(chosen.to <= N, `to ${chosen.to}`);
});

test("the index under the pointer is clamped to the window", () => {
  const window = { from: 40, to: 80 };
  assert.equal(view.indexAt(window, N, 0, even(N)), 40);
  assert.equal(view.indexAt(window, N, 1, even(N)), 79);
  // Past either end, which is what happens when the pointer leaves the plot while
  // the capture is still held.
  assert.equal(view.indexAt(window, N, -2, even(N)), 40);
  assert.equal(view.indexAt(window, N, 5, even(N)), 79);
});

test("index and fraction round-trip", () => {
  // The crosshair is placed by fraction and the readout is chosen by index, so if
  // these two disagree the label and the line part company.
  const window = { from: 10, to: 90 };
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const index = view.indexAt(window, N, fraction, even(N));
    assert.ok(Math.abs(view.fractionOf(window, N, index, even(N)) - fraction) <= 1 / (window.to - window.from - 1) + 1e-9);
  }
});

test("a window narrower than MIN_WINDOW is widened, not obeyed", () => {
  // The floor is a floor: a two-sample request comes back as MIN_WINDOW, because
  // the alternative is a chart with two points and no shape.
  const widened = view.clampView({ from: 40, to: 42 }, N);
  assert.equal(widened.to - widened.from, view.MIN_WINDOW);
  assert.equal(widened.from, 40, "the low end should stay where it was asked for");
});

test("a chart with fewer samples than the minimum window still draws", () => {
  // The floor is a minimum for ZOOMING, not a refusal to render. A kernel that
  // produced three samples has to be plottable, and a rule that produced no
  // window for it would leave the plot blank with no explanation.
  const tiny = view.clampView(view.fullView(3), 3);
  assert.deepEqual(tiny, { from: 0, to: 3 });
  assert.equal(view.indexAt(tiny, 3, 0.5, even(3)), 1);
});

test("no samples at all produces an empty window rather than NaN", () => {
  // A division by a zero span is how a chart ends up drawing NaN widths, which
  // renders as an empty box rather than as an error.
  const empty = view.clampView({ from: 0, to: 10 }, 0);
  assert.deepEqual(empty, { from: 0, to: 0 });
  assert.equal(view.indexAt(empty, 0, 0.5, []), 0);
  assert.equal(view.fractionOf(empty, 0, 0, []), 0);
});

test("clampView repairs a window that is inverted or out of range", () => {
  // Reachable from a stale drag: the sample count can drop under a window that
  // was already drawn, since the buffer is a rolling one.
  assert.equal(view.clampView({ from: 90, to: 20 }, N).to > view.clampView({ from: 90, to: 20 }, N).from, true);
  const beyond = view.clampView({ from: 500, to: 900 }, N);
  assert.ok(beyond.to <= N, `to ${beyond.to}`);
  assert.ok(beyond.from >= 0, `from ${beyond.from}`);
});

// --- the axis is simulated time, and the spacing is real -----------------------
//
// Everything below fails against the index arithmetic it replaced, on ragged
// spacing. That is the whole point: an evenly spaced fixture makes time and index
// the same function, so a test on even spacing proves nothing about the change.

test("the pointer picks the nearest point in TIME, not the nearest index", () => {
  // times: 0, 1ms, 9ms, 24ms, 46ms, 52ms. A pointer at 45% of the window sits at
  // 23.4ms, which is beside the 24ms point (index 3) and nowhere near index 2.
  // Index arithmetic says round(0.45 * 5) = 2 and puts the crosshair on the wrong
  // side of a 15ms gap.
  const times = ragged(6);
  const window = { from: 0, to: 6 };
  assert.equal(times[3], 24_000_000);
  assert.equal(view.indexAt(window, 6, 0.45, times), 3);
});

test("a crosshair in a wide gap resolves to a real point, and its fraction agrees", () => {
  const times = ragged(6);
  const window = { from: 0, to: 6 };
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const fraction = view.fractionOf(window, 6, index, times);
    assert.equal(view.indexAt(window, 6, fraction, times), index,
      `point ${index} at fraction ${fraction} did not resolve back to itself`);
  }
});

test("a point's fraction is where its TIME puts it", () => {
  const times = ragged(6);
  const window = { from: 0, to: 6 };
  // The whole point of the change: point 2 is two fifths of the way along by index
  // and about a fifth by time, because the gaps ahead of it are the small ones.
  assert.equal(times[2], 9_000_000);
  assert.equal(times[5], 47_000_000);
  assert.ok(Math.abs(view.fractionOf(window, 6, 2, times) - 9 / 47) < 1e-9,
    `expected 9/47, got ${view.fractionOf(window, 6, 2, times)}`);
  assert.ok(view.fractionOf(window, 6, 2, times) < 2 / 5);
});

test("a drag is resolved against times, so an uneven run selects what was pointed at", () => {
  // The dragged edges are times, snapped outward to the points among them. A drag
  // over the first third of the window reaches past the first two points because
  // they are close together in time, which index arithmetic would not have done.
  const times = ragged(6);
  const start = view.fullView(6);
  const chosen = view.selectRange(start, 6, 0, 0.4, 250, 500, times);
  assert.ok(chosen.to > chosen.from, "the drag selected nothing");
  assert.ok(chosen.from >= 0 && chosen.to <= 6);
});

test("repeated timestamps divide by nothing and draw at the centre", () => {
  // Two samples can share a sim time -- EmitLiveFinal skips a duplicate, but a
  // paced pair can coincide. A zero span is how a chart ends up drawing NaN widths,
  // which renders as an empty box rather than as an error.
  const window = { from: 0, to: 4 };
  const same = [5_000_000, 5_000_000, 5_000_000, 5_000_000];
  assert.equal(view.windowSpanPs(window, 4, same), 0);
  assert.equal(view.fractionOf(window, 4, 2, same), 0);
  assert.equal(view.indexAt(window, 4, 0.5, same), 0);
  // And the axis still has something to say about it.
  const axis = timeAxis.timeAxis(5_000_000, 5_000_000, 5);
  assert.equal(axis.ticks.length, 1, "a zero-width window should still label one tick");
});

test("a times array shorter than the series does not throw", () => {
  // A chart that throws while drawing is worse than one that draws a slightly wrong
  // point, and a rolling sample buffer is exactly how the two get out of step.
  const short = [0, 1_000_000];
  const span = view.windowSpanPs({ from: 0, to: 6 }, 6, short);
  assert.ok(Number.isFinite(span) && span >= 0, `span was ${span}`);
  assert.ok(Number.isFinite(view.indexAt({ from: 0, to: 6 }, 6, 0.5, short)));
  assert.ok(Number.isFinite(view.fractionOf({ from: 0, to: 6 }, 6, 5, short)));
});

test("the unit follows the window, not the run", () => {
  // The spans are the ones these runs actually produce. matmul-conflict measured
  // 4.722us to 12.884us and the L2-pressure run 3.762us to 25.183us, so microseconds
  // is the unit almost every real window lands in, and nanoseconds is what zooming
  // in earns.
  assert.equal(timeAxis.timeUnitFor(494_000).short, "ns", "494ns should label in nanoseconds");
  assert.equal(timeAxis.timeUnitFor(4_722_000).short, "µs");
  assert.equal(timeAxis.timeUnitFor(25_183_000).short, "µs");
  assert.equal(timeAxis.timeUnitFor(2_518_300_000).short, "ms");
  // Boundaries, and not a power of a thousand inside a unit: a span is never
  // labelled "0.4 ms" when "400 µs" says the same in fewer characters.
  assert.equal(timeAxis.timeUnitFor(999_999).short, "ns");
  assert.equal(timeAxis.timeUnitFor(1_000_000).short, "µs");
  assert.equal(timeAxis.timeUnitFor(999_999_999).short, "µs");
  assert.equal(timeAxis.timeUnitFor(1_000_000_000).short, "ms");
});

test("a full run labels in short numbers, not eight digits", () => {
  // The reason for the adaptive unit. 25.16us is six characters; the same span in
  // picoseconds is eight and in nanoseconds is eight, and in both the interesting
  // digits land last where the eye is not.
  const axis = timeAxis.timeAxis(494_000, 25_160_000, 5);
  assert.equal(axis.title, "Simulated time (µs)");
  for (const tick of axis.ticks) {
    assert.ok(tick.label.length <= 6, `tick label too long: ${tick.label}`);
    assert.ok(!tick.label.includes("e"), `tick label is not plain: ${tick.label}`);
  }
});

test("ticks land inside the window and on round steps", () => {
  const axis = timeAxis.timeAxis(4_722_000, 12_884_000, 5);
  assert.ok(axis.ticks.length >= 2, `too few ticks: ${JSON.stringify(axis.ticks)}`);
  for (const tick of axis.ticks) {
    assert.ok(tick.timePs >= axis.fromPs && tick.timePs <= axis.toPs,
      `tick ${tick.label} at ${tick.timePs} is outside ${axis.fromPs}..${axis.toPs}`);
  }
  const step = axis.ticks[1].timePs - axis.ticks[0].timePs;
  assert.ok(step > 0);
  for (let i = 1; i < axis.ticks.length; i++) {
    assert.equal(axis.ticks[i].timePs - axis.ticks[i - 1].timePs, step, "uneven tick spacing");
  }
  // Round multiples, so a tick does not move when the window is panned.
  assert.equal(axis.ticks[0].timePs % step, 0, "ticks are not on round multiples of the step");
});

test("ticks are distinct and few, at every window a reader can produce", () => {
  const spans = [
    [0, 52_000_000],
    [4_722_000, 4_922_000],   // 200µs
    [494_000, 494_400],       // 400ns, below a microsecond
    [24_000_000, 24_000_000], // zero span
  ];
  for (const [from, to] of spans) {
    const axis = timeAxis.timeAxis(from, to, 5);
    const labels = axis.ticks.map((tick) => tick.label);
    assert.equal(new Set(labels).size, labels.length,
      `duplicate tick labels at ${from}..${to}: ${JSON.stringify(labels)}`);
    assert.ok(axis.ticks.length <= 12, `too many ticks at ${from}..${to}: ${labels.length}`);
    assert.ok(axis.ticks.length >= 1);
  }
});

test("a tick step is a round number a reader can multiply", () => {
  assert.equal(timeAxis.niceStep(1), 1);
  assert.equal(timeAxis.niceStep(1.4), 2);
  assert.equal(timeAxis.niceStep(3), 5);
  assert.equal(timeAxis.niceStep(7), 10);
  assert.equal(timeAxis.niceStep(230), 500);
  assert.equal(timeAxis.niceStep(0.04), 0.05);
  // 2.5 x 10^n is excluded on purpose: labels differing only in the last digit are
  // unreadable at tick size and impossible to compare at a glance.
  assert.ok(!String(timeAxis.niceStep(2.5)).startsWith("2.5"));
  assert.equal(timeAxis.niceStep(0), 0, "a zero step must not become NaN");
  assert.equal(timeAxis.niceStep(-5), 0);
  assert.equal(timeAxis.niceStep(Infinity), 0);
});

test("a label carries no trailing zeros it does not need", () => {
  const us = timeAxis.timeUnitFor(25_000_000);
  assert.equal(timeAxis.formatTime(25_000_000, us, 5_000_000), "25");
  assert.equal(timeAxis.formatTime(2_500_000, us, 5_000_000), "2.5");
  assert.equal(timeAxis.formatTime(0, us, 1_000_000), "0");
  // Sub-microsecond precision appears only once the window earns it. 400_000ps is
  // 400ns; 400ps is 0.4ns, which is a different number and labels differently.
  const ns = timeAxis.timeUnitFor(400_000);
  assert.equal(timeAxis.formatTime(400_000, ns, 100_000), "400");
  assert.equal(timeAxis.formatTime(400, ns, 100), "0.4");
});
