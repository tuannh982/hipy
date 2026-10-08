import { LiveDashboard } from "./LiveDashboard";
import type { Metrics, DashboardSchema } from "../lib/protocol";

type DashboardProps = {
    metrics: readonly Metrics[];
    schema: DashboardSchema | null;
    running: boolean;
};

const EMPTY = "Run a kernel and its live metrics will appear here while it executes.";

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
