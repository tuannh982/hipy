import { useEffect, useId, useRef, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (mermaidPromise === null) {
    mermaidPromise = import("mermaid").then((module) => {
      const mermaid = module.default;
                              const root = getComputedStyle(document.documentElement);
      const token = (name: string, fallback: string): string =>
        root.getPropertyValue(name).trim() || fallback;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
                                                suppressErrorRendering: true,
        theme: "dark",
        themeVariables: {
          primaryColor: token("--vscode-sideBar-bg", "#252526"),
          primaryTextColor: token("--vscode-foreground", "#cccccc"),
          primaryBorderColor: token("--vscode-input-border", "#3c3c3c"),
          lineColor: token("--vscode-textLink-foreground", "#3794ff"),
          secondaryTextColor: token("--vscode-descriptionForeground", "#9d9d9d"),
          fontFamily: token("--font-ui", "sans-serif"),
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

export function MermaidBlock({ chart }: { chart: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
                              const renderId = `hipy-mermaid-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
                let live = true;
    void loadMermaid()
      .then(async (mermaid) => {
        const host = hostRef.current;
        if (host === null || !live) return;
        // mermaid.render returns the svg as a string rather than writing it, so
        // this assignment is the only DOM write the component makes.
        const { svg } = await mermaid.render(renderId, chart);
        if (!live) return;
        host.innerHTML = svg;
      })
      .catch((error: unknown) => {
        if (!live) return;
        setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [chart, renderId]);

        if (failure !== null) {
    return (
      <div className="mermaid-fallback">
        <strong>Diagram could not be rendered.</strong>
        <pre>{chart}</pre>
      </div>
    );
  }

  return <div className="mermaid-frame" ref={hostRef} />;
}
