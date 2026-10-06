import { LiveDashboard } from "./LiveDashboard";
import type { Metrics, DashboardSchema } from "../lib/protocol";

type DashboardProps = {
  /** The sample history, oldest first. */
  metrics: readonly Metrics[];
  /**
   * How this run's stream should be drawn, off the simulator's dashboardSchema
   * export. Null before a run has read one, and null forever if the build has no
   * such export -- which is the honest answer rather than a guessed device shape.
   */
  schema: DashboardSchema | null;
  /** True while a run is in flight. */
  running: boolean;
};

const EMPTY = "Run a kernel and its live metrics will appear here while it executes.";

/** The Dashboard tab: the live readout and nothing else. */
export function Dashboard({ metrics, schema, running }: DashboardProps) {
  if (schema === null) {
    return (
      <div className="panel-empty">
        {metrics.length === 0
          ? EMPTY
          : "This simulator build did not report a metric schema, so there is nothing to draw."}
      </div>
    );
  }
  if (metrics.length === 0) {
    return <div className="panel-empty">{EMPTY}</div>;
  }
  return (
    <div className="report">
      <LiveDashboard samples={metrics} schema={schema} running={running} />
    </div>
  );
}