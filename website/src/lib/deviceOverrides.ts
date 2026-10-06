import type { CatalogDevice } from "./catalog";
import type { SimOverrides } from "./protocol";

// The browser's copy of the simulator's size floors.
//
// The set count is derived from the same arithmetic the simulator uses, not copied
// as bare numbers: akita derives
//
//     numSets = TotalByteSize / (WayAssociativity * blockSize)
//
// and every directory lookup then computes its set as `hashedAddr % numSets`, so a
// cache with zero sets does not fail to build -- it panics with an integer divide
// by zero on first touch.
//
// Associativity and line size are NOT derived: MGPUSim builds them (16-way, 64 B)
// and does not publish them through the catalog. A device with different geometry
// needs this line changed, which is why the minimum below is computed.
const WAY_ASSOCIATIVITY = 16;
const LOG2_BLOCK_SIZE = 6; // 64 B lines

// The memory banks a device's L2 is interleaved across. Both current devices build
// 16 (r9nano/builder.go and mi300x/builder.go, numMemoryBank).
const MEMORY_BANKS = 16;

/** Bytes one set occupies: one line per way. */
export const BYTES_PER_SET = WAY_ASSOCIATIVITY * 2 ** LOG2_BLOCK_SIZE;

/**
 * The smallest set count that leaves a cache at least one set per bank.
 *
 * Not 1: one set per bank holds 16 lines in total and conflicts on nearly
 * everything, so it computes correctly and profiles meaninglessly.
 */
export const MIN_SETS_PER_BANK = 4;

/** The smallest L2 or MALL the simulator will build, in bytes. */
export const MIN_L2_BYTES = BYTES_PER_SET * MIN_SETS_PER_BANK * MEMORY_BANKS;

/**
 * The smallest L1V. Built PER CU, so it has different geometry from the L2, and it
 * measures rather than derives: 4 KiB works on both devices.
 */
export const MIN_L1V_BYTES = 4 * 1024;

/**
 * The smallest device memory, well above any single allocation, because the
 * allocator also has to hold the page tables the driver builds.
 */
export const MIN_MEMORY_BYTES = 1024 * 1024;

const FLOORS: readonly { key: keyof SimOverrides; label: string; min: number }[] = [
  { key: "l1vBytes", label: "L1 data cache", min: MIN_L1V_BYTES },
  { key: "l2Bytes", label: "L2 cache", min: MIN_L2_BYTES },
  { key: "mallBytes", label: "MALL", min: MIN_L2_BYTES },
  { key: "memoryBytes", label: "Device memory", min: MIN_MEMORY_BYTES },
];

/**
 * Every problem with a proposed set of sizes, keyed by the field it belongs to.
 *
 * Empty object when the set is acceptable, so the caller can test for "nothing
 * wrong" without a length check. Mirrors harness.ValidateSizeOverrides rather than
 * replacing it: the simulator validates again on save and its answer counts, so
 * this exists to catch a refusal before the page pays for a platform rebuild.
 *
 * A field the device does not have is not an error: the builders ignore it.
 */
export function validateOverrides(
  overrides: SimOverrides,
  device: CatalogDevice | null,
): Record<string, string> {
  const problems: Record<string, string> = {};
  const hasMALL = (device?.memLevels ?? []).includes("MALL");

  for (const { key, label, min } of FLOORS) {
    const value = overrides[key];
    // Absent means "the device default", which is never wrong here.
    if (value === undefined) continue;
    if (key === "mallBytes" && device !== null && !hasMALL) continue;
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
      problems[key] = `${label} must be a whole number of bytes`;
      continue;
    }
    // The export takes an i32 that is UNSIGNED after the sign extension
    // //go:wasmexport applies, so anything at or above 2^31 arrives as a different
    // number rather than as an error.
    if (value > 0xffffffff) {
      problems[key] = `${label} is above the 4 GiB the simulator's export can carry`;
      continue;
    }
    if (value > 0 && value < min) {
      problems[key] = `${label} of ${value} B is below the ${min} B minimum this simulator can build`;
    }
  }
  return problems;
}
