import { useEffect, useRef } from "react";

export type ConsoleEntry = {
  id: number;
  kind: "status" | "stdout" | "stderr";
  text: string;
};

type ConsoleProps = {
  entries: readonly ConsoleEntry[];
};

export function Console({ entries }: ConsoleProps) {
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [entries]);

  return (
    <section className="console-view" aria-label="Run console">
      {entries.length === 0 ? (
        <div className="panel-empty">Run a kernel to stream compiler diagnostics and host output.</div>
      ) : (
        <pre ref={outputRef} className="console-output">
          {entries.map((entry) => (
            <span className={`console-line console-${entry.kind}`} key={entry.id}>{entry.text}</span>
          ))}
        </pre>
      )}
    </section>
  );
}
