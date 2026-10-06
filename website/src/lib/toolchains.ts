// The toolchain registry (toolchain/toolchains.json), read by the browser build.
//
// The shell build path reads the same JSON through
// toolchain/src/scripts/toolchain-registry.mjs, so the two cannot end up naming
// different flags for the same toolchain.
//
// A DEVICE does not come through here. The simulator's catalog reports which
// toolchain and arch each device needs (see src/lib/catalog.ts), and this module
// is looked up with that toolchain id: the arch is a fact about the device the
// learner picked, decided at run time rather than frozen into the bundle.
//
// The validation below throws at import, so a malformed row fails the build rather
// than reaching a learner as a compile error about undefined flags.
import toolchainRegistry from "../../../toolchain/toolchains.json" with { type: "json" };

export type ToolchainDeviceArchs = Readonly<Record<string, string>>;

export type Toolchain = {
  /** The join key: what a device's catalog entry names and what the manifest is keyed by. */
  id: string;
  label: string;
  /** The built driver wasm this toolchain stages out of toolchain/artifacts/. */
  driverArtifact: string;
  /** The file name the driver is deployed under, under public/toolchain/<id>/. */
  driverFile: string;
  /** The OS/ABI triple; -target-cpu carries the ISA. */
  triple: string;
  /** Extra clang flags the device pass needs for this target. */
  devicePassArgs: readonly string[];
  /** What the offload bundler's --targets= string ends with, per ISA. */
  offloadTargetPrefix: string;
  /** What this toolchain emits when a caller names no arch at all. Never a compile decision. */
  defaultArch: string;
  /** device id -> the ISA that device's code objects are compiled for. */
  devices: ToolchainDeviceArchs;
};

const registry = toolchainRegistry as { version?: number; toolchains?: Toolchain[] };

function requireString(row: Partial<Toolchain> & { id: string }, field: keyof Toolchain): string {
  const value = row[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`toolchain/toolchains.json: toolchain "${row.id}" has no ${String(field)}`);
  }
  return value;
}

// A device id appears in two registries, and a value in only one of them is the
// exact failure this mapping exists to catch: a device the simulator builds whose
// arch nobody can produce, or an arch nobody can run. Checked at import.
function checkDevice(row: Toolchain, deviceId: string, arch: unknown): void {
  if (typeof arch !== "string" || arch.trim() === "") {
    throw new Error(`toolchain/toolchains.json: toolchain "${row.id}" claims device "${deviceId}" with no arch`);
  }
}

const toolchains: readonly Toolchain[] = (registry.toolchains ?? []).map((row) => {
  if (typeof row.id !== "string" || row.id.trim() === "") {
    throw new Error("toolchain/toolchains.json has a toolchain with no id");
  }
  for (const field of ["label", "driverArtifact", "driverFile", "triple", "offloadTargetPrefix", "defaultArch"] as const) {
    requireString(row, field);
  }
  if (!Array.isArray(row.devicePassArgs)) {
    throw new Error(`toolchain/toolchains.json: toolchain "${row.id}" has no devicePassArgs`);
  }
  const devices: Record<string, string> = {};
  for (const [deviceId, arch] of Object.entries(row.devices ?? {})) {
    checkDevice(row, deviceId, arch);
    devices[deviceId] = arch;
  }
  return { ...row, devices };
});

if (toolchains.length === 0) throw new Error("toolchain/toolchains.json lists no toolchains");

const byId = new Map(toolchains.map((row) => [row.id, row]));

/** Every toolchain, in file order. */
export function allToolchains(): readonly Toolchain[] {
  return toolchains;
}

/**
 * One toolchain by id, or null for an id the registry does not have. Null rather
 * than a throw because the id arrives from the simulator's catalog, and a catalog
 * naming a toolchain this build does not ship is a fact the caller can report.
 */
export function toolchainById(id: string | null | undefined): Toolchain | null {
  return id === null || id === undefined ? null : byId.get(id) ?? null;
}

/**
 * The ISA a device compiles for, or null when either registry lacks it. Neither
 * half guesses.
 */
export function archForDevice(toolchainId: string | null | undefined, deviceId: string | null | undefined): string | null {
  const row = toolchainById(toolchainId);
  if (row === null || deviceId === null || deviceId === undefined) return null;
  return row.devices[deviceId] ?? null;
}

/**
 * A device id this build can compile for: the first one any toolchain claims.
 *
 * For scripts and tests that need SOME device and are not choosing one. Which
 * device the playground starts on is the simulator's to report, since a device
 * MGPUSim cannot build is a legitimate entry here and not in the select.
 */
export function anyClaimedDevice(): string | null {
  for (const row of toolchains) {
    const [first] = Object.keys(row.devices);
    if (first !== undefined) return first;
  }
  return null;
}

/**
 * The offload bundler's --targets= string: a prefix plus the ISA.
 *
 * The ISA is interpolated rather than written out because the bundler embeds it,
 * and a literal would unbundle nothing for any build that is not the shipped
 * device's.
 */
export function offloadTarget(row: Toolchain, arch: string): string {
  return `${row.offloadTargetPrefix}${arch}`;
}