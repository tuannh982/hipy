import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const wasmPath = process.env.SIM_WASM ?? "/tmp/sim-runner.wasm";
const wasmExecPath = process.env.SIM_WASM_EXEC ?? "/tmp/wasm_exec.js";
await import(pathToFileURL(wasmExecPath));

const bytes = await readFile(wasmPath);
const manifest = JSON.parse(
  await readFile(new URL("../testdata/fixtures.json", import.meta.url), "utf8"),
);
let fixtures = (manifest.fixtures ?? []).filter((fixture) => fixture.uniformLaunch);
if (process.env.SIM_CODE_OBJECT) {
  const requested = path.basename(process.env.SIM_CODE_OBJECT);
  const selected = fixtures.filter((fixture) => fixture.codeObject === requested);
  if (selected.length === 0) {
    throw new Error(`SIM_CODE_OBJECT=${requested} matches no uniformLaunch fixture in the manifest`);
  }
  fixtures = selected;
}
if (fixtures.length === 0) {
  throw new Error("no fixture declares uniformLaunch");
}
const requiredExports = [
  "alloc", "loadCodeObject", "configure", "malloc", "mallocStatus", "memcpyH2D", "setKernelArgs",
  "launchKernel", "drain", "metrics", "resultPtr", "resultLen", "writeStdout",
  "stdoutPtr", "stdoutLen", "catalog", "dashboardSchema",
];

// readCatalog calls the catalog export and parses the body out of the shared result
// buffer, which is in Go memory. It takes the Go object rather than a saved buffer
// reference because building a 64-CU platform can grow Go's heap, which detaches
// the old ArrayBuffer.
//
// device names the device whose figures to read, as the same (pointer, length) pair
// of i32s configure takes, because //go:wasmexport lowers a Go string that way. An
// empty name reads the registry default. The allocation is not released:
// exports.alloc retains every buffer until teardown.
function readCatalog(exports, go, device = "") {
  const decoder = new TextDecoder();
  const bodyAt = (ptr, length) => decoder.decode(new Uint8Array(go.mem.buffer).subarray(ptr, ptr + length));

  const name = new TextEncoder().encode(device);
  const namePtr = name.length === 0 ? 0 : exports.alloc(name.length);
  if (name.length !== 0) {
    if (!namePtr) throw new Error("device name allocation failed");
    new Uint8Array(go.mem.buffer).set(name, namePtr);
  }

  // The return value is NOT a length on the failure path: every failure comes back
  // from setError as status 1 with the message left in the result buffer. The one
  // thing that holds on both paths is that a success's return value equals the
  // result buffer's length.
  const status = exports.catalog(namePtr, name.length);
  const resultLen = exports.resultLen();
  const ptr = exports.resultPtr();

  if (status <= 0 || ptr === 0) {
    throw new Error(`catalog body is empty: ${bodyAt(ptr, resultLen)}`);
  }
  if (status !== resultLen) {
    throw new Error(`catalog export failed (status ${status}): ${bodyAt(ptr, resultLen)}`);
  }
  return JSON.parse(bodyAt(ptr, status));
}

async function runScenario(fixture, maxInst, expectedDrain) {
  const recipe = fixture.uniformLaunch;
  const codeObject = await readFile(new URL(`../testdata/${fixture.codeObject}`, import.meta.url));
  const go = new Go();
  // sim-runner.wasm declares env.pushMetrics as an IMPORT and wasm resolves imports
  // at INSTANTIATION, so a missing one is a hard failure there. This script DECODES
  // what arrives rather than supplying a no-op, because it is the only place the
  // stream is exercised outside the browser and the pointer crosses the boundary as a
  // sign-extended i32.
  let goMemory = null;
  const metricFailures = [];
  const samples = [];
  let instance;
  ({ instance } = await WebAssembly.instantiate(bytes, {
    ...go.importObject,
    env: {
      ...(go.importObject?.env ?? {}),
      pushMetrics: (ptr, length) => {
        try {
          const memory = goMemory;
          if (!memory || length <= 0) return;
          const start = ptr >>> 0;
          const body = new Uint8Array(memory.buffer).slice(start, start + length);
          samples.push(JSON.parse(new TextDecoder().decode(body)));
        } catch (error) {
          metricFailures.push(`offset 0x${(ptr >>> 0).toString(16)} length ${length}: ${String(error)}`);
        }
      },
    },
  }));
  goMemory = instance.exports.mem;
  const runPromise = go.run(instance);
  const exports = instance.exports;

  for (const name of requiredExports) {
    if (typeof exports[name] !== "function") throw new Error(`missing wasm export: ${name}`);
  }

  // Read BEFORE configure, the order the browser uses: the worker instantiates the
  // module at page load, calls catalog, and hands that same instance to the first run.
  // A wasm export cannot be unit-tested in Go, so this JS caller is the only
  // coverage.
  const preConfigureCatalog = readCatalog(exports, go);
  if (preConfigureCatalog.devices.length === 0) {
    throw new Error(`catalog lists no devices before configure: ${JSON.stringify(preConfigureCatalog)}`);
  }
  // More than one device: the body has to offer a device no run has configured yet,
  // which is only possible if it lists the registry rather than the one device its
  // harness was built for.
  if (preConfigureCatalog.devices.length < 2) {
    throw new Error(`catalog lists ${preConfigureCatalog.devices.length} device(s); a select built from it can only ever offer one: ${JSON.stringify(preConfigureCatalog)}`);
  }

  // "gcn3generic" keeps this script on the inert default every other script and test
  // here uses, so their numbers stay comparable.
  const deviceName = new TextEncoder().encode("gcn3generic");
  const deviceNamePtr = exports.alloc(deviceName.length);
  if (!deviceNamePtr) throw new Error("device name allocation failed");
  new Uint8Array(go.mem.buffer).set(deviceName, deviceNamePtr);
  if (exports.configure(maxInst, deviceNamePtr, deviceName.length) !== 0) {
    const detail = new TextDecoder().decode(new Uint8Array(go.mem.buffer).subarray(exports.resultPtr(), exports.resultPtr() + exports.resultLen()));
    throw new Error(`configure failed after a catalog read: ${detail}`);
  }

  // Read again after configure: this is the read that checks the deviceName reached
  // the simulator. The described device is looked up rather than taken from index 0,
  // because the body lists the whole registry in name order.
  const catalog = readCatalog(exports, go, "gcn3generic");
  const first = catalog.devices.find((device) => device.figuresRead);
  const report = `catalog device: ${JSON.stringify(first)}`;

  if (!first) throw new Error(`catalog describes no device: ${JSON.stringify(catalog)}`);

  // Every field present, so a missing one fails here rather than as an
  // undefined in a rendered figure. disabledReason only has to be present: an empty
  // one is a fact about a device nothing is wrong with.
  for (const field of [
    "name", "label", "targetArch", "disabledReason", "vramBytes", "clockHz", "simdCount",
    "ldsBytes", "l1vBytes", "l2Bytes", "computeUnits", "l1vBytesUnread", "l2BytesUnread",
  ]) {
    if (first[field] === undefined || first[field] === null) throw new Error(`no ${field} in ${report}`);
  }
  // The device described must be the one this read asked for: a catalog built from a
  // harness that never received the configured deviceName would describe the default
  // here.
  if (first.name !== new TextDecoder().decode(deviceName)) {
    throw new Error(`catalog describes ${first.name}, want the configured ${new TextDecoder().decode(deviceName)}: ${report}`);
  }
  // Exactly one device is described; more than one would mean the export built more
  // than one platform, and none would leave the About tab with nothing to render.
  const described = catalog.devices.filter((device) => device.figuresRead);
  if (described.length !== 1) {
    throw new Error(`catalog describes ${described.length} devices, want 1: ${JSON.stringify(catalog)}`);
  }
  // Every listed device carries a memory size, described or not, so a dropdown can
  // offer every device's VRAM without a platform per device.
  for (const device of catalog.devices) {
    if (typeof device.vramBytes !== "number" || device.vramBytes <= 0) {
      throw new Error(`${device.name} modelled device memory is ${device.vramBytes} in ${JSON.stringify(device)}`);
    }
    if (device.figuresRead) continue;
    // A listed-only device has no figures, and says so. Zero compute units
    // rendered as "0" would be a fact about a device nobody has measured.
    for (const field of ["clockHz", "simdCount", "ldsBytes", "computeUnits", "l1vBytes", "l2Bytes"]) {
      if (device[field] !== 0) throw new Error(`listed-only ${device.name} has ${field} = ${device[field]}: ${JSON.stringify(device)}`);
    }
  }
  // The two fields the About heading renders.
  for (const field of ["label", "targetArch"]) {
    if (typeof first[field] !== "string" || first[field] === "") throw new Error(`${field} is empty in ${report}`);
  }
  // A zero in any of these four is a lie about the platform: no device has no clock,
  // no SIMDs, no LDS or no compute units, and none of them has an Unread flag.
  for (const field of ["clockHz", "simdCount", "ldsBytes", "computeUnits"]) {
    if (typeof first[field] !== "number" || first[field] <= 0) throw new Error(`${field} is ${first[field]} in ${report}`);
  }
  // The cache sizes are the pair that must not be read as plain numbers: an Unread
  // flag says the figure beside it is not a measurement, so the UI renders
  // "unavailable" and the number is not checked.
  for (const [figure, unread] of [["l1vBytes", "l1vBytesUnread"], ["l2Bytes", "l2BytesUnread"]]) {
    if (typeof first[unread] !== "boolean") throw new Error(`${unread} is not a boolean in ${report}`);
    if (first[unread] === true) continue;
    if (typeof first[figure] !== "number" || first[figure] <= 0) throw new Error(`${figure} is ${first[figure]} in ${report}`);
  }
  if (!catalog.devices.some((device) => device.name === catalog.defaultDevice)) {
    throw new Error(`default device ${catalog.defaultDevice} is not in the catalog's own device list: ${JSON.stringify(catalog)}`);
  }

  const codeObjectPtr = exports.alloc(codeObject.length);
  if (!codeObjectPtr) throw new Error("code object allocation failed");
  new Uint8Array(go.mem.buffer).set(codeObject, codeObjectPtr);
  if (exports.loadCodeObject(codeObjectPtr, codeObject.length) !== 0) throw new Error("loadCodeObject failed");

  // The schema, read at the same point the browser reads it: after loadCodeObject,
  // the first moment the harness exists. The assertions are the CONTRACT rather than
  // the figures, since the browser renders every chart, unit and row from this body.
  const schemaLen = exports.dashboardSchema();
  const schemaPtr = exports.resultPtr();
  if (schemaLen <= 0 || schemaPtr === 0) {
    throw new Error("dashboardSchema returned no data; the Dashboard would render nothing");
  }
  const schema = JSON.parse(new TextDecoder().decode(new Uint8Array(go.mem.buffer).subarray(schemaPtr, schemaPtr + schemaLen)));
  for (const field of ["title", "runningEyebrow", "finalEyebrow", "runningBadge", "finalBadge", "badge", "footer"]) {
    if (typeof schema[field] !== "string" || schema[field] === "") {
      throw new Error(`dashboardSchema has no ${field}: ${JSON.stringify(schema).slice(0, 400)}`);
    }
  }
  if (!Array.isArray(schema.charts) || schema.charts.length === 0) {
    throw new Error(`dashboardSchema has ${schema.charts?.length} charts; the Dashboard would draw none`);
  }
  for (const chart of schema.charts) {
    for (const field of ["id", "eyebrow", "title", "layout", "valueKind", "xUnit", "yUnit"]) {
      if (typeof chart[field] !== "string" || chart[field] === "") {
        throw new Error(`a chart has no ${field}: ${JSON.stringify(chart)}`);
      }
    }
    // A kind the browser does not implement would put every point one sample late.
    if (!["value", "rate", "bytes"].includes(chart.valueKind)) {
      throw new Error(`chart ${chart.id} declares valueKind ${chart.valueKind}, which the panel does not implement`);
    }
    if (!Array.isArray(chart.series) || chart.series.length === 0) {
      throw new Error(`chart ${chart.id} has no series: ${JSON.stringify(chart)}`);
    }
    for (const series of chart.series) {
      for (const field of ["id", "label", "path", "hue"]) {
        if (typeof series[field] !== "string" || series[field] === "") {
          throw new Error(`a series on ${chart.id} has no ${field}: ${JSON.stringify(series)}`);
        }
      }
    }
  }
  // The hierarchy rows are the levels and the meters are the hit-rate grid; both empty
  // means a panel with two sections silently missing.
  for (const section of [["hierarchy", schema.hierarchy], ["meters", schema.meters]]) {
    const [name, body] = section;
    if (!body || typeof body !== "object") throw new Error(`dashboardSchema has no ${name}: ${JSON.stringify(schema).slice(0, 400)}`);
  }
  if (!Array.isArray(schema.hierarchy.rows) || schema.hierarchy.rows.length === 0) {
    throw new Error("dashboardSchema has no hierarchy rows");
  }
  for (const row of schema.hierarchy.rows) {
    for (const field of ["label", "readPath", "writePath"]) {
      if (typeof row[field] !== "string" || row[field] === "") {
        throw new Error(`a hierarchy row has no ${field}: ${JSON.stringify(row)}`);
      }
    }
  }
  if (!Array.isArray(schema.meters.entries) || schema.meters.entries.length === 0) {
    throw new Error("dashboardSchema has no hit-rate meters");
  }
  // Every series path must be a path the samples carry, or the chart draws an empty
  // plot with no error anywhere. Checked against a real body below.
  for (const chart of schema.charts) {
    for (const series of chart.series) {
      if (series.path.includes("..") || series.path.startsWith(".")) {
        throw new Error(`chart ${chart.id} series ${series.id} has malformed path ${series.path}`);
      }
    }
  }

  const n = recipe.elements;
  const pointers = [];
  for (let index = 0; index < recipe.pointerArgs; index++) {
    const device = exports.malloc(n * 4);
    if (device <= 0) throw new Error("device allocation failed");
    pointers.push(device);
  }
  for (let index = 0; index < recipe.h2dBuffers; index++) {
    const host = exports.alloc(n * 4);
    // Real little-endian float32 per element, matching the Go side's f32Bytes.
    const view = new DataView(go.mem.buffer);
    for (let i = 0; i < n; i++) {
      view.setFloat32(host + i * 4, index === 0 ? i : i * 2 + 1, true);
    }
    if (exports.memcpyH2D(pointers[index], host, n * 4) !== 0) {
      // The export recovers a panic and leaves the reason in the result buffer.
      const detail = new TextDecoder().decode(new Uint8Array(go.mem.buffer).subarray(exports.resultPtr(), exports.resultPtr() + exports.resultLen()));
      throw new Error(`memcpyH2D failed: ${detail}`);
    }
  }

  // Pointers are 64-bit on this target, so each occupies 8 bytes and the u32 args
  // follow at an 8-aligned offset. Packing a pointer into 4 bytes produces a block the
  // COV5 prologue (s_load_dwordx4 s[0:3], s[4:5], 0x0) reads as 8-byte pointers, and
  // the first flat_load_dword faults with "page not found".
  const argBytes = recipe.pointerArgs * 8 + recipe.u32Args.length * 4;
  const args = exports.alloc(argBytes);
  const argView = new DataView(go.mem.buffer);
  pointers.forEach((device, index) => argView.setBigUint64(args + index * 8, BigInt(device), true));
  recipe.u32Args.forEach((value, index) =>
    argView.setUint32(args + recipe.pointerArgs * 8 + index * 4, value, true),
  );
  if (exports.setKernelArgs(args, argBytes) !== 0) throw new Error("setKernelArgs failed");

  const name = fixture.kernel;
  const namePtr = exports.alloc(name.length);
  new Uint8Array(go.mem.buffer).set(new TextEncoder().encode(name), namePtr);
  if (exports.launchKernel(namePtr, name.length, ...recipe.grid, ...recipe.block) !== 0) {
    throw new Error("launchKernel failed");
  }

  const expectedStdout = new TextEncoder().encode("hello");
  const stdoutHost = exports.alloc(expectedStdout.length);
  new Uint8Array(go.mem.buffer).set(expectedStdout, stdoutHost);
  if (exports.writeStdout(stdoutHost, expectedStdout.length) !== 0) {
    throw new Error("writeStdout failed");
  }
  const stdoutLength = exports.stdoutLen();
  const stdout = new Uint8Array(go.mem.buffer, exports.stdoutPtr(), stdoutLength);
  if (stdout.length !== expectedStdout.length ||
      !stdout.every((byte, index) => byte === expectedStdout[index])) {
    throw new Error(`unexpected stdout: ${new TextDecoder().decode(stdout)}`);
  }

  const drainStatus = exports.drain();
  if (drainStatus !== expectedDrain) {
    throw new Error(`drain status ${drainStatus}, want ${expectedDrain}`);
  }
  if (exports.launchKernel(namePtr, name.length, ...recipe.grid, ...recipe.block) === 0) {
    throw new Error("staged kernel arguments were reused");
  }
  const metricsLength = exports.metrics();
  const metricsPtr = exports.resultPtr();
  if (metricsLength <= 0 || metricsPtr === 0) throw new Error("metrics body is empty");
  const metrics = JSON.parse(new TextDecoder().decode(new Uint8Array(go.mem.buffer).subarray(metricsPtr, metricsPtr + metricsLength)));
  if (!Array.isArray(metrics.resourceMetrics) || metrics.resourceMetrics.length === 0) {
    throw new Error(`unexpected metrics body: ${JSON.stringify(metrics)}`);
  }
  const metricNames = metrics.resourceMetrics.flatMap((resource) =>
    (resource.scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.name)));
  const otlpKernelDurationName = "hipy.simulator.kernel.duration";
  if (!metricNames.includes(otlpKernelDurationName)) {
    throw new Error(`OTLP metrics body is missing ${otlpKernelDurationName}: ${JSON.stringify(metricNames)}`);
  }
  // A panic crossing a //go:wasmexport boundary exists only at this layer, so this is
  // the only place the device-memory limit crossing is observable from JS.
  //
  // LAST in the scenario, because the probe spends the whole device and there is no
  // putting it back: Free returns a single page per call, not the range an allocation
  // covered.
  //
  // One page past the whole device, not exactly the whole device: by this point the
  // fixture has taken some of it, so asking for all of it would fail for the wrong
  // reason. Where the boundary sits exactly is the Go test's job.
  //
  // The status comes from mallocStatus, not from malloc's own return, which is a
  // device pointer and is zero on the failure path.
  const limit = catalog.devices.find((device) => device.figuresRead)?.vramBytes;
  if (typeof limit !== "number" || limit <= 0) {
    throw new Error(`the catalog reports no device memory to test against: ${JSON.stringify(catalog.devices)}`);
  }
  exports.malloc(limit + 4096);
  const overStatus = exports.mallocStatus();
  const overMessage = new TextDecoder().decode(new Uint8Array(go.mem.buffer).subarray(exports.resultPtr(), exports.resultPtr() + exports.resultLen()));
  if (overStatus === 0) {
    throw new Error(`malloc past the modelled device memory (${limit} bytes) reported success; the limit is not enforced, so a kernel would corrupt memory instead of failing`);
  }
  if (overMessage.trim() === "") {
    throw new Error(`malloc past the device memory limit failed with status ${overStatus} and no message; a learner would see a failure with no reason`);
  }
  // The message must survive the wasmexport boundary intact: the shared result buffer
  // is truncated to resultLen, so a message that grew past it would arrive cut off
  // mid-sentence and still contain the device name.
  const overText = overMessage.trim();
  for (const [what, pattern] of [
    ["which device ran out", /gcn3generic|cdna3generic/],
    ["that it was device memory", /device memory/i],
    ["the limit", /\d+(\.\d+)?\s?(B|KiB|MiB|GiB)/],
  ]) {
    if (!pattern.test(overText)) {
      throw new Error(`the out-of-memory message a learner sees does not name ${what}: ${JSON.stringify(overText)}`);
    }
  }
  // The request size is the last clause, so it is what a truncated message loses first.
  if (!overText.includes(String(limit + 4096))) {
    throw new Error(`the out-of-memory message a learner sees does not state the size of the ` +
      `request: ${JSON.stringify(overText)}`);
  }
  console.log(`over-vram ok: ${limit} bytes modelled, +4096 fails with status ${overStatus} and ${JSON.stringify(overText)}`);
  // A sample that arrived has to be a real one. Checked conditionally, because the
  // trigger is a stride over retired instructions, so a kernel below the stride is
  // silent. That the stream fires at all is a whole-run claim, asserted after the
  // loop below.
  if (metricFailures.length > 0) {
    throw new Error(`the metrics callback could not read Go memory: ${metricFailures.join("; ")}`);
  }
  const last = samples[samples.length - 1];
  if (last !== undefined && !(last.simTimePs > 0 && last.instructions > 0 && last.totalCus > 0)) {
    throw new Error(`a sample reported nothing moving: ${JSON.stringify(last)}`);
  }
  if (last !== undefined) {
    // The schema's paths against a sample that arrived, the one check the panel cannot
    // make for itself. The derived paths are the browser's, so only the dotted field
    // paths are walked here.
    const derived = new Set(["elapsedSinceLaunchPs"]);
    const resolves = (path) => {
      if (derived.has(path)) return true;
      let cursor = last;
      for (const key of path.split(".")) {
        if (typeof cursor !== "object" || cursor === null) return false;
        cursor = cursor[key];
      }
      return typeof cursor === "number";
    };
    for (const chart of schema.charts) {
      for (const series of chart.series) {
        if (!resolves(series.path)) {
          throw new Error(`chart ${chart.id} series ${series.id} names ${series.path}, which no sample carries`);
        }
      }
    }
    for (const row of schema.hierarchy.rows) {
      for (const path of [row.readPath, row.writePath]) {
        if (!resolves(path)) {
          throw new Error(`hierarchy row ${row.label} names ${path}, which no sample carries`);
        }
      }
    }
    // The pointer crossed as a sign-extended i32: reading it at all is the coercion.
    peakLanes = Math.max(peakLanes, last.activeSimds);
    console.log(`samples: ${samples.length}, ${last.activeSimds}/${last.totalSimds} lanes active, ${last.vramUsedBytes}/${last.vramCapacityBytes} bytes of device memory`);
  }
  totalSamples += samples.length;
  console.log(`smoke ok: metrics_body=${metricsLength} drain=${drainStatus} otlp_kernel_metric=${otlpKernelDurationName} samples=${samples.length}`);
  void runPromise;
}

// Run-wide tallies, so "the stream fired" and "a lane was busy" are asked once over
// every scenario rather than of each kernel individually.
let totalSamples = 0;
let peakLanes = 0;

for (const fixture of fixtures) {
  await runScenario(fixture, 2_000_000, 0);
  if (process.env.SIM_SKIP_CUTOFF !== "1") {
    await runScenario(fixture, 1, 1);
  }
}

// The stream exists, fired, and carried something. An import that is supplied and
// never called is indistinguishable from a trigger that stopped firing.
if (totalSamples === 0) {
  throw new Error(`no metrics sample arrived across ${fixtures.length} fixtures and their cutoff runs: ` +
    `the import is wired but nothing is calling it`);
}
console.log(`PASS: metrics stream (${totalSamples} samples, peak ${peakLanes} lanes active)`);
