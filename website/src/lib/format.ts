function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function scaleBytes(value: number): { value: number; unit: string } {
  const bytes = Math.max(0, finite(value));
  if (bytes === 0) return { value: 0, unit: "B" };
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  return { value: bytes / 1024 ** unitIndex, unit: BYTE_UNITS[unitIndex] };
}

// Two decimals above a byte, none at one: every figure this serves is a running
// total read off a telemetry counter.
export function formatBytes(value: number): string {
  const scaled = scaleBytes(value);
  return `${scaled.value.toFixed(scaled.unit === "B" ? 0 : 2)} ${scaled.unit}`;
}

export function formatDurationNs(value: number): string {
  const nanoseconds = Math.max(0, finite(value));
  if (nanoseconds === 0) return "0 ns";
  if (nanoseconds < 1_000) return `${nanoseconds.toFixed(0)} ns`;
  if (nanoseconds < 1_000_000) return `${(nanoseconds / 1_000).toFixed(2)} µs`;
  if (nanoseconds < 1_000_000_000) return `${(nanoseconds / 1_000_000).toFixed(2)} ms`;
  return `${(nanoseconds / 1_000_000_000).toFixed(2)} s`;
}

export function formatHitRate(rate: number): string {
  if (!Number.isFinite(rate) || rate === 0) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}
