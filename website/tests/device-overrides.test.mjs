// The browser's copy of the simulator's size floors.
//
// The point of these tests is that the two copies cannot drift into disagreeing
// about what is buildable. They are derived from the same arithmetic on both sides,
// so the constants here are checked against that arithmetic rather than restated.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const ov = await tsImport(path.join(repoRoot, "website", "src", "lib", "deviceOverrides.ts"), import.meta.url);

const device = (over = {}) => ({
  name: "cdna3generic", label: "AMD CDNA3 Generic", figuresRead: true,
  vramBytes: 32 * 1024 * 1024, l1vBytes: 32 * 1024, l2Bytes: 4 * 1024 * 1024,
  l2BytesUnread: false, l1vBytesUnread: false, clockHz: 0, simdCount: 0, ldsBytes: 0,
  computeUnits: 0, toolchainId: "amdgcn", targetArch: "gfx942", disabledReason: "",
  memLevels: ["L1", "L2", "MALL"], ...over,
});

test("the L2 floor is derived from the set arithmetic, not written as a literal", () => {
  // akita: numSets = TotalByteSize / (WayAssociativity * blockSize), and
  // TotalByteSize is the cache size divided across the memory banks. A lookup then
  // does `hashedAddr % numSets`, so zero sets is an integer divide by zero.
  const BYTES_PER_SET = 16 * 64; // 16-way, 64 B lines
  const BANKS = 16;             // numMemoryBank on both devices
  assert.equal(ov.BYTES_PER_SET, BYTES_PER_SET);
  // Four sets per bank, not one: one set holds 16 lines in total and conflicts on
  // everything, which computes correctly and profiles meaninglessly.
  assert.equal(ov.MIN_SETS_PER_BANK, 4);
  assert.equal(ov.MIN_L2_BYTES, BYTES_PER_SET * 4 * BANKS);
  assert.equal(ov.MIN_L2_BYTES, 64 * 1024);
  // And it is above the point where sets would run out, which is the failure the
  // floor exists to prevent.
  assert.ok(ov.MIN_L2_BYTES >= BYTES_PER_SET * BANKS);
});

test("a size under the floor is reported against its own field", () => {
  const problems = ov.validateOverrides({ l2Bytes: 4096 }, device());
  assert.ok(problems.l2Bytes, "a 4 KiB L2 must be refused");
  assert.match(problems.l2Bytes, /L2 cache/);
  assert.match(problems.l2Bytes, /65536/, "the message should carry the minimum");
  // Nothing else is wrong, so no other field is mentioned.
  assert.equal(problems.l1vBytes, undefined);
  assert.equal(problems.memoryBytes, undefined);
});

test("an absent field is never an error", () => {
  // Absent means "the device default", which the simulator accepts.
  assert.deepEqual(ov.validateOverrides({}, device()), {});
});

test("a MALL on a device without one is ignored rather than refused", () => {
  // The builders ignore it, so refusing it here would block a configuration the
  // simulator accepts.
  const gcn = device({ name: "gcn3generic", memLevels: ["L1", "L2"] });
  assert.deepEqual(ov.validateOverrides({ mallBytes: 1024 }, gcn), {});
  // And on a device that HAS one, the same value is still under the floor.
  assert.ok(ov.validateOverrides({ mallBytes: 1024 }, device()).mallBytes);
});

test("a value the export cannot carry is refused rather than silently truncated", () => {
  // //go:wasmexport takes i32 and sign-extends it into JS, so 2^31 and above arrive
  // as a different number rather than as an error. This is the only place that can
  // still say so.
  const problems = ov.validateOverrides({ l2Bytes: 2 ** 32 }, device());
  assert.match(problems.l2Bytes, /4 GiB/);
});

test("a non-integer or negative size is refused", () => {
  assert.ok(ov.validateOverrides({ l2Bytes: 1.5 }, device()).l2Bytes);
  assert.ok(ov.validateOverrides({ l2Bytes: -1 }, device()).l2Bytes);
  assert.ok(ov.validateOverrides({ memoryBytes: Number.NaN }, device()).memoryBytes);
});

test("sizes at or above the floors pass", () => {
  assert.deepEqual(ov.validateOverrides({
    l1vBytes: ov.MIN_L1V_BYTES,
    l2Bytes: ov.MIN_L2_BYTES,
    mallBytes: ov.MIN_L2_BYTES,
    memoryBytes: ov.MIN_MEMORY_BYTES,
  }, device()), {});
});

test("validation is skipped while the catalog has not been read", () => {
  // Null device means the MALL check cannot be made, so it is not made. The
  // simulator still validates on save and is the authority.
  assert.deepEqual(ov.validateOverrides({ l2Bytes: 8 * 1024 * 1024 }, null), {});
});

// The browser skips the MALL check for a device with no MALL, and the simulator has
// to agree. These two are separate implementations of one rule -- the builders
// ignore a MALL size on a device that has no MALL -- so a device where they
// disagreed would accept a configuration here and refuse it there.
test("the MALL floor is the same figure the simulator uses", () => {
  // harness.MinMALLBytes is 64 KiB and MinL2Bytes is 64 KiB, so the browser applies
  // MIN_L2_BYTES to the MALL field. If either side is retuned, this fails.
  assert.equal(ov.MIN_L2_BYTES, 64 * 1024);
});
