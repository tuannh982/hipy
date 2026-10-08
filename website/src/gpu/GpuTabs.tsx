import { Console } from "../components/Console";
import { CustomizePanel } from "../components/CustomizePanel";
import { Dashboard } from "../components/Dashboard";
import { LdsInspector } from "../components/LdsInspector";
import { ToolchainBoundaries } from "../components/ToolchainBoundaries";
import type { GpuRun } from "./useGpuRun";

export function GpuTabs({ gpu }: { gpu: GpuRun }) {
  return (
    <section className="output-pane">
      <nav className="tabs" aria-label="Output views">
        {gpu.tabs.map((tab) => (
          <button
            className={`${gpu.activeTab === tab ? "active" : ""} ${gpu.partialTelemetry && gpu.telemetryTabs.includes(tab) ? "partial" : ""}`}
            onClick={() => gpu.setActiveTab(tab)}
            key={tab}
          >
            {tab}{gpu.partialTelemetry && gpu.telemetryTabs.includes(tab) ? " · partial" : ""}
            {tab === "LDS" && gpu.ldsModel && <i className="tab-dot" />}
          </button>
        ))}
      </nav>
      <div className="tab-content">
        {gpu.activeTab === "Console" && <Console entries={gpu.entries} />}
        {gpu.activeTab === "Dashboard" && (
          <Dashboard metrics={gpu.samples} schema={gpu.dashboardSchema} running={gpu.running} />
        )}
        {gpu.activeTab === "LDS" && (
          <LdsInspector
            lds={gpu.telemetry?.lds ?? null}
            targetArch={gpu.arch}
            onJumpToLine={gpu.revealLineAt}
          />
        )}
        {gpu.activeTab === "Customize" && (
          <CustomizePanel
            device={gpu.selected}
            overrides={gpu.overrides}
            errors={gpu.overrideErrors}
            saving={gpu.configuring}
            runActive={gpu.running}
            onChange={gpu.setOverrides}
            onSave={gpu.saveConfiguration}
          />
        )}
        {gpu.activeTab === "About" && (
          <div className="about-view">
            <span className="eyebrow">Toolchain</span>
            <h3 className="about-subhead">What this toolchain will not build</h3>
            <p className="table-note">
              Diagnostics this toolchain refuses to emit, so a missing feature reads as a
              known limit rather than a broken build. Each one is a hard failure, not a
              silent approximation.
            </p>
            <ToolchainBoundaries />
          </div>
        )}
      </div>
    </section>
  );
}
