import toolchainRegistry from "../../../toolchain/toolchains.json" with { type: "json" };

export type ToolchainDeviceArchs = Readonly<Record<string, string>>;

export type Toolchain = {
    id: string;
  label: string;
    driverArtifact: string;
    driverFile: string;
    triple: string;
    devicePassArgs: readonly string[];
    offloadTargetPrefix: string;
    defaultArch: string;
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

export function allToolchains(): readonly Toolchain[] {
  return toolchains;
}

export function toolchainById(id: string | null | undefined): Toolchain | null {
  return id === null || id === undefined ? null : byId.get(id) ?? null;
}

export function archForDevice(toolchainId: string | null | undefined, deviceId: string | null | undefined): string | null {
  const row = toolchainById(toolchainId);
  if (row === null || deviceId === null || deviceId === undefined) return null;
  return row.devices[deviceId] ?? null;
}

export function anyClaimedDevice(): string | null {
  for (const row of toolchains) {
    const [first] = Object.keys(row.devices);
    if (first !== undefined) return first;
  }
  return null;
}

export function offloadTarget(row: Toolchain, arch: string): string {
  return `${row.offloadTargetPrefix}${arch}`;
}
