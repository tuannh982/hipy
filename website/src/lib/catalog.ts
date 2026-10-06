// The simulator's own description of itself: the JSON body the `catalog`
// wasmexport marshals (simulator/wasmexec/exports.go).
//
// Every selector answers null rather than a guess. A caller handed null has to
// decide what to show, and that decision is the one a guess takes away.
import { scaleBytes } from "./format";

// A device as the export reports it. The field names are the Go json tags.
//
// The two Unread flags make a figure and a statement about the figure separate
// fields: cacheByteSize reads a cache size by switching on a component's concrete
// type, so an unnamed cache flavour matches nothing. Unread true means the figure
// beside it is not a measurement -- for L2, a partial sum over the banks that did
// answer. Unread false with a zero figure is a real zero: no such cache was built.
export type CatalogDevice = {
  name: string;
  label: string;
  // The toolchain that compiles for this device, and the ISA it emits. Both come
  // from the simulator's registry, so this is a claim to check, not an
  // instruction: the browser looks the id up in toolchain/toolchains.json.
  toolchainId: string;
  targetArch: string;
  disabledReason: string;
  // The modelled device memory, in bytes. Read off the platform configuration
  // rather than off a built platform, so a select can offer every device's VRAM
  // without building a platform per device.
  vramBytes: number;
  // Whether the figures below are a measurement. The simulator describes ONE
  // device per catalog read, because reading a device's figures means building its
  // platform, and building every platform costs hundreds of megabytes of heap Go
  // does not give back.
  figuresRead: boolean;
  clockHz: number;
  simdCount: number;
  ldsBytes: number;
  l1vBytes: number;
  l1vBytesUnread: boolean;
  l2Bytes: number;
  l2BytesUnread: boolean;
  /**
   * The whole MALL -- CDNA3's Infinity Cache between L2 and DRAM. Zero on a device
   * with no MALL, which `memLevels` distinguishes from a MALL that saw no traffic.
   */
  mallBytes: number;
  mallBytesUnread: boolean;
  computeUnits: number;
  /**
   * The cache levels this device built, innermost first. Null when the figures
   * have not been read, because nothing has been built -- a different claim from a
   * device that built no such level.
   */
  memLevels: string[] | null;
};

export type CatalogBody = {
  devices: CatalogDevice[];
  defaultDevice: string;
};

// What a device select renders. `value` is the name the wasm configure export
// takes; the toolchain and arch ride along so a caller need not reach past the
// list.
export type DeviceOption = {
  value: string;
  label: string;
  toolchainId: string;
  targetArch: string;
  /** The device's modelled VRAM, carried so a select can show it without a second lookup. */
  vramBytes: number;
  disabled: boolean;
  disabledReason: string;
};

// The catalog's own devices, in body order. A null body is an empty list rather
// than a fault: the caller has nothing to select and can say so. Every registry
// device is here whether or not its figures have been read.
export function deviceOptions(body: CatalogBody | null): readonly DeviceOption[] {
  if (body === null) return [];
  return body.devices.map((device) => ({
    value: device.name,
    label: device.label,
    toolchainId: device.toolchainId,
    targetArch: device.targetArch,
    vramBytes: device.vramBytes,
    disabled: device.disabledReason !== "",
    disabledReason: device.disabledReason,
  }));
}

// The catalog's own default, or null when it names a device the body does not list.
export function defaultDevice(body: CatalogBody | null): string | null {
  if (body === null) return null;
  return body.devices.some((device) => device.name === body.defaultDevice) ? body.defaultDevice : null;
}

// One device's figures, or null for a name the catalog does not have.
export function selectDevice(body: CatalogBody | null, name: string): CatalogDevice | null {
  if (body === null) return null;
  return body.devices.find((device) => device.name === name) ?? null;
}

/**
 * The device whose figures this body actually carries, or null. Null means every
 * entry is a listing, so nothing in the body is a measurement of anything.
 */
export function describedDevice(body: CatalogBody | null): CatalogDevice | null {
  if (body === null) return null;
  return body.devices.find((device) => device.figuresRead) ?? null;
}

// The arch to compile for, or null for a device the catalog does not have.
export function targetArchFor(body: CatalogBody | null, device: string): string | null {
  return selectDevice(body, device)?.targetArch ?? null;
}

/**
 * The toolchain and arch one device compiles with, or a pair of nulls.
 *
 * Returned together because a compile takes both and neither is meaningful alone:
 * the arch is named by a toolchain, and the toolchain knows which driver wasm and
 * clang flags emit it. There is no shape here offering one without the other.
 */
export function toolchainFor(body: CatalogBody | null, device: string): { toolchainId: string; arch: string } | null {
  const selected = selectDevice(body, device);
  if (selected === null || selected.toolchainId === "" || selected.targetArch === "") return null;
  return { toolchainId: selected.toolchainId, arch: selected.targetArch };
}

// The one word this file prints for a figure nobody can vouch for. Exported rather
// than retyped per row so a second spelling of the same state never sits beside
// formatCacheBytes's "unknown".
export const unknownFigure = "unknown";

// A figure for a device whose figures the catalog does not carry, or the number
// itself when it does. The whole row set goes through here rather than each row
// deciding for itself, because the catalog gives an undescribed device zeros in
// every figure field.
export function deviceFigure(value: number, figuresRead: boolean): string {
  return figuresRead && Number.isFinite(value) && value > 0 ? String(value) : unknownFigure;
}

/**
 * A cache size for an About row, or "unknown" when there is nothing to vouch for:
 * the Unread flag is set, or the value is non-positive.
 *
 * The flag is a parameter rather than something a caller folds into a 0, because
 * the figure beside it is not then necessarily zero -- an unreadable L2 arrives as
 * a partial sum.
 *
 * Distinct from format.ts's formatBytes, which prints a bare 0 (right for
 * telemetry: zero DRAM bytes moved is a real fact about a run) and wrong for a
 * figure read off a constructed component.
 */
export function formatCacheBytes(value: number, unread = false): string {
  if (unread || !Number.isFinite(value) || value <= 0) return unknownFigure;
  const scaled = scaleBytes(value);
  const oneDecimal = scaled.value.toFixed(1);
  const rendered = oneDecimal.endsWith(".0") ? oneDecimal.slice(0, -2) : oneDecimal;
  return `${rendered} ${scaled.unit}`;
}

// A clock in GHz with one decimal, or "unknown" when there is no figure. It takes
// no unread flag: only the two cache sizes are paired with one, because only those
// are read by switching on a concrete type.
export function formatHertz(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return unknownFigure;
  return `${(value / 1_000_000_000).toFixed(1)} GHz`;
}