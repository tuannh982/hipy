import type { ReactNode } from "react";
import { formatCacheBytes } from "../lib/catalog";
import type { GpuRun } from "./useGpuRun";

export function GpuToolbar({ gpu, extra }: { gpu: GpuRun; extra?: ReactNode }) {
  return (
    <div className="editor-toolbar">
      {extra}
      <label className="example-select">
        <span>Device</span>
        <select
          value={gpu.device}
          onChange={(event) => gpu.selectSimulatedDevice(event.target.value)}
          aria-label="Simulated GPU"
          disabled={gpu.options.length === 0}
        >
          {gpu.options.length === 0 && (
            <option value="" disabled>{gpu.catalogError === null ? "Loading…" : "Unavailable"}</option>
          )}
          {gpu.options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled} title={option.disabledReason}>
              {option.label} · {formatCacheBytes(option.vramBytes)}{option.disabledReason === "" ? "" : ` — ${option.disabledReason}`}
            </option>
          ))}
        </select>
        {gpu.deviceStale && (
          <span className="device-stale" role="status">Changed since last run</span>
        )}
      </label>
      <div className={`stage-pill stage-${gpu.stage}`}><i /><span className="stage-text">{gpu.stageLabel}</span></div>
      <div className={`sim-pill sim-${gpu.simStatus}`} role="status">
        <i />
        <span>{gpu.simStatusLabel}</span>
        {gpu.simStatus === "crashed" && (
          <button className="button button-small" onClick={gpu.restartSimulator}>Restart simulator</button>
        )}
      </div>
      <div className="run-actions">
        {gpu.running && <span className="elapsed">{(gpu.elapsedMs / 1_000).toFixed(1)} s</span>}
        {gpu.running
          ? <button className="button button-danger" onClick={gpu.cancel}>Cancel</button>
          : gpu.simStatus === "crashed"
            ? <button className="button button-primary" disabled title="Restart the simulator first">▶ Run</button>
            : <button className="button button-primary" onClick={gpu.run}>▶ Run</button>}
      </div>
    </div>
  );
}
