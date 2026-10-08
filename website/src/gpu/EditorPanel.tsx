import { CudaEditor } from "../editor/CudaEditor";
import { unknownFigure } from "../lib/catalog";
import type { GpuRun } from "./useGpuRun";

export function EditorPanel({
  source,
  gpu,
  onSourceChange,
}: {
  source: string;
  gpu: GpuRun;
  onSourceChange(next: string): void;
}) {
  const handleChange = (next: string): void => {
    gpu.noteSourceEdited();
    onSourceChange(next);
  };

  return (
    <>
      {gpu.download && (
        <div className="download-progress" role="status">
          <div>
            <strong>First-run toolchain download</strong>
            <span>{gpu.progressPercent === null ? "Preparing…" : `${gpu.progressPercent.toFixed(0)}%`}</span>
          </div>
          <progress max={100} value={gpu.progressPercent ?? 0} />
        </div>
      )}
      <CudaEditor
        value={source}
        diagnostics={gpu.diagnostics}
        revealLine={gpu.revealLine}
        onChange={handleChange}
      />
      <footer className="editor-footer">
        <span>HIP · {gpu.arch ?? (gpu.catalog === null ? "Not loaded" : unknownFigure)}</span>
      </footer>
    </>
  );
}
