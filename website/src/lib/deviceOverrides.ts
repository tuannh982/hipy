import type { CatalogDevice } from "./catalog";
import type { SimOverrides } from "./protocol";

const WAY_ASSOCIATIVITY = 16;
const LOG2_BLOCK_SIZE = 6; // 64 B lines

// The memory banks a device's L2 is interleaved across. Both current devices build
// 16 (r9nano/builder.go and mi300x/builder.go, numMemoryBank).
const MEMORY_BANKS = 16;

export const BYTES_PER_SET = WAY_ASSOCIATIVITY * 2 ** LOG2_BLOCK_SIZE;

export const MIN_SETS_PER_BANK = 4;

export const MIN_L2_BYTES = BYTES_PER_SET * MIN_SETS_PER_BANK * MEMORY_BANKS;

export const MIN_L1V_BYTES = 4 * 1024;

export const MIN_MEMORY_BYTES = 1024 * 1024;

const FLOORS: readonly { key: keyof SimOverrides; label: string; min: number }[] = [
  { key: "l1vBytes", label: "L1 data cache", min: MIN_L1V_BYTES },
  { key: "l2Bytes", label: "L2 cache", min: MIN_L2_BYTES },
  { key: "mallBytes", label: "MALL", min: MIN_L2_BYTES },
  { key: "memoryBytes", label: "Device memory", min: MIN_MEMORY_BYTES },
];

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
