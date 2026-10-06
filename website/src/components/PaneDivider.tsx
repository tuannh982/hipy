import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// The divider between the editor and the output panel, and the only way the width
// of the editor is changed.
//
// It moves a CSS custom property on the workspace rather than writing a track size
// itself, so the narrow-viewport rules still work: they set `grid-template-columns`
// to a single column and hide this element, and an inline value from here would
// outrank both.
//
// The width is in pixels rather than a ratio so a stored width from a wide window
// can survive a narrow one; the clamp below is the only place that can notice.

const storageKey = "hipy:editor-width:v1";

// Narrower than this and the source is unreadable, so the drag stops rather than
// letting the output panel vanish.
const minimumWidth = 280;
// The output pane's own floor, from .workspace's grid rule.
const outputMinimum = 380;
// The divider's own track, likewise from the grid rule.
const dividerWidth = 6;
const arrowStep = 24;
const shiftStep = 96;

/**
 * The editor width for a workspace of `available` pixels.
 *
 * Clamped at both ends, and the two ends are different kinds of bound: a floor on
 * the editor, and whatever is left once the output pane has had its own floor. An
 * `available` too small to satisfy both resolves to the minimum, because the output
 * pane can scroll and Monaco cannot.
 */
export function clampEditorWidth(available: number, requested: number): number {
  if (!Number.isFinite(requested)) return minimumWidth;
  const maximum = Math.max(minimumWidth, available - outputMinimum - dividerWidth);
  return Math.round(Math.min(Math.max(requested, minimumWidth), maximum));
}

// A width persisted by an earlier visit, or null for "the CSS default". Null means
// nothing has been dragged yet, and the grid keeps its own ratio until something is.
export function storedEditorWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const width = Number.parseInt(raw, 10);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

function rememberEditorWidth(width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // A session that cannot persist the width still resizes; it just forgets.
  }
}

export function PaneDivider({
  container,
  value,
  onChange,
}: {
  // The element the widths are measured against, as a ref rather than an element: a
  // ref is current from the first commit, where a prop holding `ref.current` is
  // not. Null on the ref means the workspace has unmounted.
  container: RefObject<HTMLElement | null>;
  value: number | null;
  onChange: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  // The workspace's own width, tracked rather than read during render: the clamp
  // below has to re-run when it does.
  const [available, setAvailable] = useState(0);
  // The pointer's starting position and the width it started from, so a move is read
  // as a delta from the drag rather than as an absolute position.
  const originRef = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const measure = (): void => setAvailable(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [container]);

  const widthAt = useCallback(
    (clientX: number): number => {
      const origin = originRef.current;
      if (origin === null) return minimumWidth;
      return clampEditorWidth(available, origin.width + (clientX - origin.x));
    },
    [available],
  );

  const move = useCallback(
    (width: number): void => {
      if (width === value) return;
      rememberEditorWidth(width);
      onChange(width);
    },
    [onChange, value],
  );

  // A width persisted against a wider window is re-clamped here rather than on the
  // next drag, or opening the playground on a laptop after resizing it on a monitor
  // would push the output panel off screen. It writes through onChange and not
  // through move(), so the clamped width is NOT persisted: the stored number is the
  // reader's preference for a screen big enough to hold it.
  useEffect(() => {
    if (value === null || available === 0) return;
    const clamped = clampEditorWidth(available, value);
    if (clamped !== value) onChange(clamped);
  }, [available, onChange, value]);

  const begin = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (container.current === null) return;
    // The width the drag starts from is the state value when there is one, and the
    // rendered width of the editor pane when there is not -- which is the FIRST drag,
    // since the grid is still on the CSS default.
    const rendered = event.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? minimumWidth;
    originRef.current = { x: event.clientX, width: value ?? rendered };
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
    move(clampEditorWidth(available, value + delta));
  };

  // A keyboard equivalent, because a divider only a pointer can move is a divider a
  // keyboard cannot use. The steps are the same for both keys and differ only in
  // size.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") { nudge(-(event.shiftKey ? shiftStep : arrowStep)); event.preventDefault(); return; }
    if (event.key === "ArrowRight") { nudge(event.shiftKey ? shiftStep : arrowStep); event.preventDefault(); }
  };

  // The accessible bounds are the same two the clamp uses, so what a screen reader
  // announces is the range the drag actually allows.
  const maximum = Math.max(minimumWidth, available - outputMinimum - dividerWidth);

  return (
    <div
      className={`pane-divider${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the editor"
      aria-valuenow={value ?? undefined}
      aria-valuemin={minimumWidth}
      aria-valuemax={maximum}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={(event) => { if (originRef.current === null) return; move(widthAt(event.clientX)); }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}