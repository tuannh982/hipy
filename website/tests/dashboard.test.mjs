// Three things are exercised here, split by where a mistake would show.
//
// The RATE. Every sample is cumulative, so every rate is a difference between two of
// them, and the interesting cases are the degenerate ones -- one sample, a clock that
// did not move, a counter that went backwards. A rate that returns 0 for "I cannot
// tell yet" prints identically to a memory system that moved no traffic.
//
// The PATH. Series and notes name sample fields as dot-separated strings, because
// the hierarchy's fields live in a map keyed by the device's own cache levels, so
// "memLevels.MALL.readSinceLaunchBytes" cannot be a typed field. A path that does not
// resolve must read as ABSENT rather than as zero: "this device has no MALL" and
// "the MALL moved nothing" are different claims.
//
// The POINTER. //go:wasmimport lowers its parameters to i32 and wasm sign-extends an
// i32 into JavaScript, so a Go address at or above 0x80000000 arrives negative. The
// CDNA3 platform's heap grows past 2 GiB and the GCN3 device's stays near 0.3 GB,
// so this is invisible on the small device and a hard throw on the large one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const dash = await tsImport(path.join(repoRoot, "website", "src", "lib", "dashboard.ts"), import.meta.url);
const { createMetricsStream } = await tsImport(path.join(repoRoot, "website", "src", "lib", "metricsStream.ts"), import.meta.url);

/** A sample with only the fields a test cares about; the rest default to zero. */
function sample(over = {}) {
  return {
    simTimePs: 0,
    launchSimTimePs: 0,
    kernelTimePs: 0,
    vramUsedBytes: 0,
    vramCapacityBytes: 1 << 30,
    dramReadBytes: 0,
    dramWriteBytes: 0,
    dramReadSinceLaunchBytes: 0,
    dramWriteSinceLaunchBytes: 0,
    dramReadTransactions: 0,
    dramWriteTransactions: 0,
    activeCus: 0,
    totalCus: 64,
    activeSimds: 0,
    totalSimds: 256,
    waves: 0,
    instructions: 0,
    cacheHitRate: {},
    tlbHitRate: 0,
    ...over,
  };
}

const SECOND_PS = 1e12;

// A chart of the shape the simulator sends for DRAM traffic, rebuilt here so the
// test does not depend on the Go side to exercise the arithmetic. The schema is
// data: a panel renders whatever it is handed, so the panel's arithmetic is
// testable without a simulator.
const dramChart = {
  id: "dram",
  valueKind: "rate",
  series: [
    { id: "dram-read", label: "DRAM reads", path: "dramReadSinceLaunchBytes", hue: "read" },
    { id: "dram-write", label: "DRAM writes", path: "dramWriteSinceLaunchBytes", hue: "write" },
  ],
};

test("a rate has one point per interval, and the times are shifted to match", () => {
  const history = [
    sample({ simTimePs: 0 }),
    sample({ simTimePs: 1 * SECOND_PS, dramReadSinceLaunchBytes: 1e9 }),
    sample({ simTimePs: 2 * SECOND_PS, dramReadSinceLaunchBytes: 3e9 }),
  ];
  const { values, times } = dash.chartSeries(dramChart, history, history[history.length - 1]);
  // Three samples describe two intervals. A series the length of the history would
  // put a rate at index 0 where no interval has happened yet.
  assert.equal(values[0].length, 2);
  assert.deepEqual(values[0], [1, 2]);
  // The times come back WITH the values, and are shifted: point i is the interval
  // ENDING at sample i+1. This stream is paced per 256 retired instructions, so a
  // rate drawn against the samples' own times shifts the whole curve.
  assert.deepEqual(times, [1 * SECOND_PS, 2 * SECOND_PS]);
});

test("a value series is one point per sample, on the samples' own times", () => {
  const chart = { id: "lanes", valueKind: "value", series: [{ id: "l", label: "Active lanes", path: "activeSimds", hue: "share" }] };
  const lanesHistory = [
    sample({ simTimePs: 0, activeSimds: 7 }),
    sample({ simTimePs: SECOND_PS, activeSimds: 0 }),
  ];
  const { values, times } = dash.chartSeries(chart, lanesHistory, lanesHistory[lanesHistory.length - 1]);
  assert.deepEqual(values[0], [7, 0]);
  assert.deepEqual(times, [0, SECOND_PS]);
});

test("a byte series is in MiB, because the axis is labelled in axis units", () => {
  // "0.19" beside a MiB axis is a number a reader holds and 196608 is not.
  const chart = { id: "vram", valueKind: "bytes", series: [{ id: "v", label: "Allocated", path: "vramUsedBytes", hue: "memory" }] };
  const vramHistory = [
    sample({ vramUsedBytes: 192 * 1024 }),
    sample({ vramUsedBytes: 256 * 1024 }),
  ];
  const { values } = dash.chartSeries(chart, vramHistory, vramHistory[vramHistory.length - 1]);
  assert.deepEqual(values[0], [0.1875, 0.25]);
});

test("a single sample yields no rate point at all", () => {
  // A rate is a difference, so one sample describes no interval.
  assert.deepEqual(dash.seriesValues([sample()], "dramReadSinceLaunchBytes", "rate"), []);
});

test("a counter that went backwards reads as zero traffic, not negative traffic", () => {
  // Cannot happen from the simulator -- its counters only increment -- and a
  // negative rate on a chart is a line below the floor, so the difference is floored
  // rather than trusting the wire.
  const values = dash.seriesValues([
    sample({ simTimePs: 1 * SECOND_PS, dramWriteSinceLaunchBytes: 5000 }),
    sample({ simTimePs: 2 * SECOND_PS, dramWriteSinceLaunchBytes: 10 }),
  ], "dramWriteSinceLaunchBytes", "rate");
  assert.deepEqual(values, [0]);
});

test("a stalled interval is a gap in the series, not a zero", () => {
  // A gap and a zero are different: the chart must not draw a flat line across an
  // interval where the clock did not advance, because that reads as no traffic.
  const values = dash.seriesValues([
    sample({ simTimePs: 0 }),
    sample({ simTimePs: SECOND_PS, dramReadSinceLaunchBytes: 1e9 }),
    sample({ simTimePs: SECOND_PS, dramReadSinceLaunchBytes: 1e9 }),
  ], "dramReadSinceLaunchBytes", "rate");
  assert.equal(values[1], undefined);
});

test("the rate ignores the setup traffic that precedes the launch", () => {
  // The host-to-device copies and any memset are themselves DRAM writes and all
  // complete before the first instruction, so a series differenced off the ABSOLUTE
  // totals sits at a flat line for the whole run and reads as "this kernel never
  // writes anything".
  const values = dash.seriesValues([
    sample({ simTimePs: 0, dramWriteBytes: 200_532, dramWriteSinceLaunchBytes: 0 }),
    sample({ simTimePs: 1 * SECOND_PS, dramWriteBytes: 200_532, dramWriteSinceLaunchBytes: 0 }),
    sample({ simTimePs: 2 * SECOND_PS, dramWriteBytes: 266_068, dramWriteSinceLaunchBytes: 65_536 }),
  ], "dramWriteSinceLaunchBytes", "rate");
  // Flat, then one interval carrying the whole 64 KiB as the L2 is flushed.
  assert.deepEqual(values, [0, 65_536 / 1e9]);
});

test("a cache level's rate is differenced through a map, per level", () => {
  // The path for a level is DATA, because the level set differs by device: L1V on
  // one, MALL on another. A path that cannot be written down cannot be tested.
  const at = (read, write, simTimePs) =>
    sample({ simTimePs, memLevels: { L1: { readSinceLaunchBytes: read, writeSinceLaunchBytes: write } } });
  const values = dash.seriesValues(
    [at(0, 0, 0), at(2e9, 1e9, SECOND_PS)],
    "memLevels.L1.readSinceLaunchBytes",
    "rate",
  );
  // DECIMAL gigabytes, which is the unit the DRAM chart already reports in, so a
  // cache row and the DRAM row are comparable on one axis.
  assert.ok(Math.abs(values[0] - 2) < 1e-9, `read = ${values[0]}, want 2 GB/s`);
});

test("a path into a level the device does not have is absent, not zero", () => {
  // This is the whole reason the paths are strings: "the device has no MALL" and "the
  // MALL moved nothing" are different claims.
  const values = dash.seriesValues(
    [sample({ simTimePs: 0 }), sample({ simTimePs: SECOND_PS })],
    "memLevels.MALL.readSinceLaunchBytes",
    "rate",
  );
  assert.deepEqual(values, [undefined]);
});

test("a level that appears from nothing does not report a spike", () => {
  // A monotonic counter appearing between two samples would draw a vertical jump
  // sized like a whole interval's traffic, which is an artifact of the map.
  const values = dash.seriesValues([
    sample({ simTimePs: 0, memLevels: {} }),
    sample({ simTimePs: SECOND_PS, memLevels: { L1: { readSinceLaunchBytes: 9999, writeSinceLaunchBytes: 0 } } }),
  ], "memLevels.L1.readSinceLaunchBytes", "rate");
  assert.deepEqual(values, [undefined]);
});

test("a path that is not a finite number resolves to nothing", () => {
  const latest = sample({ cacheHitRate: { L1V: 0.5 } });
  assert.equal(dash.readPath(latest, "cacheHitRate.L1V"), 0.5);
  assert.equal(dash.readPath(latest, "cacheHitRate.MALL"), undefined);
  assert.equal(dash.readPath(latest, "nope"), undefined);
  assert.equal(dash.readPath(latest, "cacheHitRate.L1V.deeper"), undefined);
});

// A traffic chart's per-kernel breakdown, as the schema hands it over.
const KERNEL_CHART = {
  ...dramChart,
  kernelSeries: {
    readPath: "kernelTraffic.%d.levels.DRAM.readBytes",
    writePath: "kernelTraffic.%d.levels.DRAM.writeBytes",
  },
};

const withKernels = (history, kernels) => history.map((entry, index) => ({
  ...entry,
  kernelTraffic: kernels.slice(0, index + 1),
}));

test("a numeric segment in a path indexes an array", () => {
  // The index is left in for the walker to follow into the array.
  const latest = sample({ kernelTraffic: [{ kernel: "a", levels: { DRAM: { readBytes: 11, writeBytes: 12 } } }] });
  assert.equal(dash.readPath(latest, "kernelTraffic.0.levels.DRAM.readBytes"), 11);
  assert.equal(dash.readPath(latest, "kernelTraffic.0.levels.DRAM.writeBytes"), 12);
  // Out of range and non-numeric are both absent rather than a wrong answer.
  assert.equal(dash.readPath(latest, "kernelTraffic.1.levels.DRAM.readBytes"), undefined);
  assert.equal(dash.readPath(latest, "kernelTraffic.nope.levels.DRAM.readBytes"), undefined);
  assert.equal(dash.readPath(latest, "kernelTraffic.-1.levels.DRAM.readBytes"), undefined);
});

test("a traffic chart grows one series per kernel, in the order they launched", () => {
  const history = withKernels(
    [
      sample({ simTimePs: 0 }),
      sample({ simTimePs: SECOND_PS, dramReadSinceLaunchBytes: 1e9 }),
      sample({ simTimePs: 2 * SECOND_PS, dramReadSinceLaunchBytes: 3e9 }),
    ],
    [
      { kernel: "reduceBlocks", launches: 1, firstSimTimePs: 0, lastSimTimePs: 1e9, levels: { DRAM: { readBytes: 0, writeBytes: 0 } } },
      { kernel: "reduceFinal", launches: 1, firstSimTimePs: 1e9, lastSimTimePs: 2e9, levels: { DRAM: { readBytes: 0, writeBytes: 0 } } },
    ],
  );
  const { kernels } = dash.chartSeries(KERNEL_CHART, history, history[history.length - 1]);

  assert.deepEqual(kernels.map((entry) => entry.kernel), ["reduceBlocks", "reduceFinal"]);
  // Two kernels must not share a hue.
  assert.notEqual(kernels[0].color, kernels[1].color);
});

test("a kernel's series is a gap before it has launched and flat after it stops", () => {
  const entry = (readBytes) => ({
    kernel: "reduceBlocks", launches: 1, firstSimTimePs: 0, lastSimTimePs: 4e9,
    levels: { DRAM: { readBytes, writeBytes: 0 } },
  });
  const history = [
    sample({ simTimePs: 0 }),
    sample({ simTimePs: SECOND_PS }),
    sample({ simTimePs: 2 * SECOND_PS, kernelTraffic: [entry(0.5e9)] }),
    sample({ simTimePs: 3 * SECOND_PS, kernelTraffic: [entry(2e9)] }),
    sample({ simTimePs: 4 * SECOND_PS, kernelTraffic: [entry(2e9)] }),
  ];
  const { kernels } = dash.chartSeries(KERNEL_CHART, history, history[history.length - 1]);

  const [reads] = kernels[0].values;
  // Absent before it launched, rather than zero: it had not run, which is a
  // different claim from having moved nothing.
  assert.equal(reads[0], undefined);
  // The interval it appears in is a gap too, because a rate is a difference and the
  // sample before it had no reading to difference against. So the hill starts one
  // interval after the kernel does.
  assert.equal(reads[1], undefined);
  assert.equal(reads[2], 1.5);
  // And flat once it stopped, which is what makes the hill end where the kernel did.
  assert.equal(reads[3], 0);
});

test("a chart whose schema declares no breakdown grows no kernel series", () => {
  const history = withKernels(
    [sample({ simTimePs: 0 }), sample({ simTimePs: SECOND_PS })],
    [{ kernel: "k", launches: 1, firstSimTimePs: 0, lastSimTimePs: 1e9, levels: { DRAM: { readBytes: 1, writeBytes: 1 } } }],
  );
  const { kernels, values } = dash.chartSeries(dramChart, history, history[history.length - 1]);
  assert.deepEqual(kernels, []);
  assert.equal(values.length, dramChart.series.length);
});

test("a run that has launched nothing has no kernel series to draw", () => {
  const history = [sample({ simTimePs: 0 }), sample({ simTimePs: SECOND_PS })];
  const { kernels } = dash.chartSeries(KERNEL_CHART, history, history[history.length - 1]);
  assert.deepEqual(kernels, []);
});

test("a note is filled from the newest sample", () => {
  const latest = sample({ dramReadBytes: 1024, dramWriteBytes: 512, instructions: 691712, waves: 10808 });
  assert.equal(
    dash.renderNote(
      "{dramReadBytes:bytes} read and {dramWriteBytes:bytes} written over {instructions:count} instructions in {waves:count} wavefronts.",
      latest,
    ),
    "1.00 KiB read and 512 B written over 691,712 instructions in 10,808 wavefronts.",
  );
});

test("a memory note says how close to the limit a reader is", () => {
  // "15.00 MiB of 16.00 MiB (94%)" says it; neither half on its own does. It is the
  // one format that takes a second path, which is why it is the only one.
  assert.equal(
    dash.renderNote("{vramUsedBytes:memory/vramCapacityBytes}", sample({ vramUsedBytes: 15 << 20, vramCapacityBytes: 16 << 20 })),
    "15.00 MiB of 16.00 MiB (94%)",
  );
});

test("an elapsed note is measured since the launch, not since the engine began", () => {
  // The H2D copies ahead of a launch tick the engine, so the raw clock reads high
  // before the kernel has done anything and would disagree with the finished kernel
  // time for one run.
  const latest = sample({ simTimePs: 5e6, launchSimTimePs: 4e6 });
  assert.equal(dash.renderNote("{elapsedSinceLaunchPs:duration} since launch", latest), "1.00 µs since launch");
  // The raw clock would say 5.00 µs.
  assert.equal(dash.renderNote("{simTimePs:duration}", latest), "5.00 µs");
});

test("a clock that went backwards is floored, not printed negative", () => {
  assert.equal(
    dash.renderNote("{elapsedSinceLaunchPs:duration}", sample({ simTimePs: 1, launchSimTimePs: 1e6 })),
    "0 ns",
  );
});

test("a token the schema cannot resolve is left alone rather than thrown", () => {
  // A schema from a different simulator must cost one ugly heading, not a blank
  // panel: the panel is a view over data it does not own.
  assert.equal(dash.renderNote("{noSuchField:bytes}", sample()), "{noSuchField:bytes}");
  assert.equal(dash.renderNote("{waves:sideways}", sample({ waves: 3 })), "{waves:sideways}");
});

test("a byte axis keeps two decimals only where they are readable", () => {
  const format = dash.yAxisFormat("bytes");
  assert.equal(format(0.1875), "0.19");
  assert.equal(format(16), "16");
  assert.equal(dash.yAxisFormat("value")(7), "7");
});

test("a reference line is read off the sample, so it cannot drift from the axis", () => {
  const chart = { id: "lanes", reference: { path: "totalSimds", label: "lanes" } };
  assert.deepEqual(dash.referenceLine(chart, sample()), { value: 256, label: "256 lanes" });
  // A sample that cannot say what the ceiling is gets no line rather than a
  // fabricated one.
  assert.equal(dash.referenceLine(chart, sample({ totalSimds: undefined })), null);
  assert.equal(dash.referenceLine({ id: "vram" }, sample()), null);
});

test("a chart warns on the figure, not on the shape of the line", () => {
  // Whether a 94% fill is one allocation from failing depends on what the program
  // does next, which no chart can show -- so the heading carries the figure and the
  // heading is what warns.
  const chart = { id: "vram", warn: { path: "vramUsedBytes", capacityPath: "vramCapacityBytes", atLeast: 0.9 } };
  assert.equal(dash.shouldWarn(chart, sample({ vramUsedBytes: 15 << 20, vramCapacityBytes: 16 << 20 })), true);
  assert.equal(dash.shouldWarn(chart, sample({ vramUsedBytes: 8 << 20, vramCapacityBytes: 16 << 20 })), false);
  // A device reporting no memory is not "full"; dividing by it would be a NaN.
  assert.equal(dash.shouldWarn(chart, sample({ vramUsedBytes: 1, vramCapacityBytes: 0 })), false);
  assert.equal(dash.shouldWarn({ id: "lanes" }, sample()), false);
});

test("the hierarchy resolves each row against the sample", () => {
  const rows = [
    { label: "L1", readPath: "memLevels.L1.readSinceLaunchBytes", writePath: "memLevels.L1.writeSinceLaunchBytes" },
    { label: "MALL", readPath: "memLevels.MALL.readSinceLaunchBytes", writePath: "memLevels.MALL.writeSinceLaunchBytes" },
    { label: "DRAM", readPath: "dramReadSinceLaunchBytes", writePath: "dramWriteSinceLaunchBytes" },
  ];
  const latest = sample({
    dramReadSinceLaunchBytes: 192 * 1024,
    memLevels: { L1: { readSinceLaunchBytes: 14_537 * 1024, writeSinceLaunchBytes: 64 * 1024 } },
  });
  const resolved = dash.hierarchyRows(rows, latest);
  assert.equal(resolved.find((r) => r.label === "L1").readBytes, 14_537 * 1024);
  // A level the device does not have is not present, and it is not zero either.
  const mall = resolved.find((r) => r.label === "MALL");
  assert.equal(mall.present, false);
  assert.equal(mall.readBytes, 0);
  // DRAM is on every device, so it resolves even with no traffic.
  assert.equal(resolved.find((r) => r.label === "DRAM").present, true);
});

test("a hit rate the sample cannot answer is absent, not zero", () => {
  // "L1I 0%" for a kernel that never fetched an instruction would be a measurement.
  assert.equal(dash.meterValue("cacheHitRate.L1V", sample({ cacheHitRate: { L1V: 0.94 } })), 0.94);
  assert.equal(dash.meterValue("cacheHitRate.L1I", sample({ cacheHitRate: { L1V: 0.94 } })), undefined);
});



// 0x88a25b40 as an i32 is negative. The CDNA3 platform hands out this address once
// its heap has grown past 2 GiB; the GCN3 device's stays near 0.3 GB.
const ABOVE_2GIB = 0x88a25b40;
const bigMemory = () => new WebAssembly.Memory({ initial: 36864 });

test("the live import reads a body Go addressed above 2 GiB", () => {
  const memory = bigMemory();
  const body = new TextEncoder().encode(JSON.stringify(sample({ instructions: 512 })));
  new Uint8Array(memory.buffer).set(body, ABOVE_2GIB);

  const received = [];
  const dropped = [];
  const stream = createMetricsStream({
    memory: () => memory,
    onMetrics: (value) => received.push(value),
    onUnreadable: (message) => dropped.push(message),
  });

  stream(ABOVE_2GIB | 0, body.length);

  assert.deepEqual(dropped, [], "the body was reported unreadable instead of decoded");
  assert.equal(received.length, 1);
  assert.equal(received[0].instructions, 512);
});

test("the live import decodes a body below 2 GiB unchanged", () => {
  // A coercion that mangled a small address would pass the test above.
  const memory = new WebAssembly.Memory({ initial: 1 });
  const body = new TextEncoder().encode(JSON.stringify(sample({ instructions: 7 })));
  new Uint8Array(memory.buffer).set(body, 4096);

  const received = [];
  createMetricsStream({
    memory: () => memory,
    onMetrics: (value) => received.push(value),
    onUnreadable: () => {},
  })(4096, body.length);

  assert.equal(received[0].instructions, 7);
});

test("a body that cannot be read is dropped and reported, not thrown", () => {
  // The stream adds a readout; the finished telemetry body is authoritative and
  // supersedes it, so failing a run over one lost sample would trade a real result
  // for a cosmetic one. The report carries the offset.
  const memory = new WebAssembly.Memory({ initial: 1 });
  const dropped = [];
  const stream = createMetricsStream({
    memory: () => memory,
    onMetrics: () => {},
    onUnreadable: (message) => dropped.push(message),
  });
  assert.doesNotThrow(() => stream(1 << 20, 8));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /metrics sample dropped: offset 0x100000 length 8/);
});

test("a body arriving before the instance exists is ignored, not thrown", () => {
  // The instance's memory does not exist until instantiate returns, and the sink
  // reads it through a holder rather than assuming it.
  const received = [];
  const stream = createMetricsStream({
    memory: () => null,
    onMetrics: (value) => received.push(value),
    onUnreadable: (message) => assert.fail(`a missing memory was reported as unreadable: ${message}`),
  });
  assert.doesNotThrow(() => stream(0, 0));
  assert.doesNotThrow(() => stream(4096, 12));
  assert.deepEqual(received, []);
});