import { useRef, useState } from "react";
import { PaneDivider, storedEditorWidth } from "../components/PaneDivider";
import { ExamplePicker } from "../examples/ExamplePicker";
import { defaultSource, examples } from "../examples/registry";
import { EditorPanel } from "../gpu/EditorPanel";
import { GpuTabs } from "../gpu/GpuTabs";
import { GpuToolbar } from "../gpu/GpuToolbar";
import { useGpuRun } from "../gpu/useGpuRun";
import { PLAYGROUND_DRAFT_KEY } from "../lib/drafts";
import { useDraft } from "../useDraft";

export function PlaygroundPage() {
  const [source, setSource] = useDraft({
    storageKey: PLAYGROUND_DRAFT_KEY,
    fallback: defaultSource,
  });
  const gpu = useGpuRun({ source });

        const workspaceRef = useRef<HTMLDivElement | null>(null);
          const [editorWidth, setEditorWidth] = useState<number | null>(storedEditorWidth);

  return (
    <div
      className="workspace"
      ref={workspaceRef}
      style={editorWidth === null ? undefined : { "--editor-width": `${editorWidth}px` } as React.CSSProperties}
    >
      {/* The editor's width rides in as a custom property rather than as a track
          size, so the narrow-viewport rule still wins. See .workspace. */}
      <section className="editor-pane">
        <GpuToolbar
          gpu={gpu}
          extra={
            <ExamplePicker
              source={source}
              onSelect={(id) => {
                const example = examples.find((item) => item.id === id);
                if (example === undefined) return;
                setSource(example.source);
                                                                                gpu.noteSourceEdited();
              }}
            />
          }
        />
        <EditorPanel
          source={source}
          gpu={gpu}
          onSourceChange={setSource}
        />
      </section>

      <PaneDivider container={workspaceRef} value={editorWidth} onChange={setEditorWidth} />

      <GpuTabs gpu={gpu} />
    </div>
  );
}
