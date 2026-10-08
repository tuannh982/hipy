import { toolchainBoundaries } from "../lib/toolchainBoundaries";

const phaseNote = (phase: string) => (phase === "compile" ? "Fails to compile" : "Fails at launch");

export function ToolchainBoundaries() {
  return (
    <dl className="config-grid">
      {toolchainBoundaries.map((boundary) => (
        <div key={boundary.id}>
          <dt>
            {boundary.label}
            <abbr title={boundary.detail}>?</abbr>
          </dt>
          <dd>
            Rejected
                        <code className="boundary-message">{boundary.message}</code>
            <small>{phaseNote(boundary.phase)}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}
