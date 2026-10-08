import { scaleBytes } from "./format";

export type CatalogDevice = {
  name: string;
  label: string;
        toolchainId: string;
  targetArch: string;
  disabledReason: string;
        vramBytes: number;
          figuresRead: boolean;
  clockHz: number;
  simdCount: number;
  ldsBytes: number;
  l1vBytes: number;
  l1vBytesUnread: boolean;
  l2Bytes: number;
  l2BytesUnread: boolean;
    mallBytes: number;
  mallBytesUnread: boolean;
  computeUnits: number;
    memLevels: string[] | null;
};

export type CatalogBody = {
  devices: CatalogDevice[];
  defaultDevice: string;
};

export type DeviceOption = {
  value: string;
  label: string;
  toolchainId: string;
  targetArch: string;
    vramBytes: number;
  disabled: boolean;
  disabledReason: string;
};

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

export function describedDevice(body: CatalogBody | null): CatalogDevice | null {
  if (body === null) return null;
  return body.devices.find((device) => device.figuresRead) ?? null;
}

// The arch to compile for, or null for a device the catalog does not have.
export function targetArchFor(body: CatalogBody | null, device: string): string | null {
  return selectDevice(body, device)?.targetArch ?? null;
}

export function toolchainFor(body: CatalogBody | null, device: string): { toolchainId: string; arch: string } | null {
  const selected = selectDevice(body, device);
  if (selected === null || selected.toolchainId === "" || selected.targetArch === "") return null;
  return { toolchainId: selected.toolchainId, arch: selected.targetArch };
}

export const unknownFigure = "unknown";

export function deviceFigure(value: number, figuresRead: boolean): string {
  return figuresRead && Number.isFinite(value) && value > 0 ? String(value) : unknownFigure;
}

export function formatCacheBytes(value: number, unread = false): string {
  if (unread || !Number.isFinite(value) || value <= 0) return unknownFigure;
  const scaled = scaleBytes(value);
  const oneDecimal = scaled.value.toFixed(1);
  const rendered = oneDecimal.endsWith(".0") ? oneDecimal.slice(0, -2) : oneDecimal;
  return `${rendered} ${scaled.unit}`;
}

export function formatHertz(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return unknownFigure;
  return `${(value / 1_000_000_000).toFixed(1)} GHz`;
}
