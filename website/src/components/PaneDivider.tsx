import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type PaneOrientation = "vertical" | "horizontal";

const editorWidthKey = "hipy:editor-width:v1";

export function editorWidthStorageKey(): string {
  return editorWidthKey;
}

// Narrower than this and the source is unreadable, so a drag stops rather than
// letting the far pane vanish.
const minimumWidth = 280;
// The output pane's own floor, from .workspace's grid rule.
const outputMinimum = 380;
// Shorter than this and the editor is a letterbox; the toolbar and footer alone
// would be most of it.
const minimumHeight = 160;
// The tab strip plus some console, below which the output pane cannot be read.
const outputMinimumHeight = 140;
// The divider's own track, likewise from the grid rules.
const dividerWidth = 6;
const arrowStep = 24;
const shiftStep = 96;

export function clampEditorWidth(available: number, requested: number): number {
  if (!Number.isFinite(requested)) return minimumWidth;
  const maximum = Math.max(minimumWidth, available - outputMinimum - dividerWidth);
  return Math.round(Math.min(Math.max(requested, minimumWidth), maximum));
}

export function clampEditorHeight(available: number, requested: number): number {
  if (!Number.isFinite(requested)) return minimumHeight;
  const maximum = Math.max(minimumHeight, available - outputMinimumHeight - dividerWidth);
  return Math.round(Math.min(Math.max(requested, minimumHeight), maximum));
}

function clampFor(orientation: PaneOrientation, available: number, requested: number): number {
  return orientation === "vertical"
    ? clampEditorWidth(available, requested)
    : clampEditorHeight(available, requested);
}

function minimumFor(orientation: PaneOrientation): number {
  return orientation === "vertical" ? minimumWidth : minimumHeight;
}

function reservedFor(orientation: PaneOrientation): number {
  return orientation === "vertical" ? outputMinimum : outputMinimumHeight;
}

// A size persisted by an earlier visit, or null for "the CSS default". Null means
// nothing has been dragged yet, and the grid keeps its own ratio until something is.
export function storedPaneSize(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const size = Number.parseInt(raw, 10);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

export function rememberPaneSize(key: string, size: number): void {
  try {
    window.localStorage.setItem(key, String(size));
  } catch {
    // A session that cannot persist the size still resizes; it just forgets.
  }
}

export function storedEditorWidth(): number | null {
  return storedPaneSize(editorWidthKey);
}

export function PaneDivider({
  container,
  value,
  onChange,
  orientation = "vertical",
  storageKey,
  label,
}: {
        container: RefObject<HTMLElement | null>;
  value: number | null;
  onChange: (size: number) => void;
  orientation?: PaneOrientation;
  // Each divider needs its own key. Two dividers sharing one would make the
  // lesson pane's width and the editor's height overwrite each other.
  storageKey?: string;
  label?: string;
}) {
  const [dragging, setDragging] = useState(false);
  // The workspace's own extent along the drag axis, tracked rather than read during
  // render: the clamp below has to re-run when it does.
  const [available, setAvailable] = useState(0);
  // The pointer's starting position and the size it started from, so a move is read
  // as a delta from the drag rather than as an absolute position.
  const originRef = useRef<{ at: number; size: number } | null>(null);

  // The key defaults to the workspace divider's own, so a caller that does not name
  // one keeps the historical behaviour exactly.
  const key = storageKey ?? editorWidthKey;
  const vertical = orientation === "vertical";
  const minimum = minimumFor(orientation);
  const reserved = reservedFor(orientation);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const measure = (): void => {
      const box = element.getBoundingClientRect();
      setAvailable(vertical ? box.width : box.height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // `vertical` is in the closure; a change of axis is a different divider, and
    // React remounts it by key rather than re-running this against the new axis.
  }, [container, vertical]);

  const sizeAt = useCallback(
    (client: number): number => {
      const origin = originRef.current;
      if (origin === null) return minimum;
      return clampFor(orientation, available, origin.size + (client - origin.at));
    },
    [available, minimum, orientation],
  );

  const move = useCallback(
    (size: number): void => {
      if (size === value) return;
      rememberPaneSize(key, size);
      onChange(size);
    },
    [key, onChange, value],
  );

            useEffect(() => {
    if (value === null || available === 0) return;
    const clamped = clampFor(orientation, available, value);
    if (clamped !== value) onChange(clamped);
  }, [available, onChange, orientation, value]);

  const begin = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (container.current === null) return;
                const rendered =
      event.currentTarget.previousElementSibling?.getBoundingClientRect()[vertical ? "width" : "height"] ??
      minimum;
    originRef.current = { at: vertical ? event.clientX : event.clientY, size: value ?? rendered };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const end = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    originRef.current = null;
    setDragging(false);
  };

  const nudge = (delta: number): void => {
    if (value === null) return;
    move(clampFor(orientation, available, value + delta));
  };

        const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? shiftStep : arrowStep;
    if (vertical) {
      if (event.key === "ArrowLeft") { nudge(-step); event.preventDefault(); return; }
      if (event.key === "ArrowRight") { nudge(step); event.preventDefault(); }
      return;
    }
    if (event.key === "ArrowUp") { nudge(-step); event.preventDefault(); return; }
    if (event.key === "ArrowDown") { nudge(step); event.preventDefault(); }
  };

  // The accessible bounds are the same two the clamp uses, so what a screen reader
  // announces is the range the drag actually allows.
  const maximum = Math.max(minimum, available - reserved - dividerWidth);

  return (
    <div
      className={`pane-divider ${vertical ? "vertical" : "horizontal"}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label ?? (vertical ? "Resize the editor" : "Resize the editor height")}
      aria-valuenow={value ?? undefined}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={(event) => {
        if (originRef.current === null) return;
        move(sizeAt(vertical ? event.clientX : event.clientY));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
