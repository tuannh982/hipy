
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { area, curveMonotoneX, line } from "d3-shape";
import { headroom, linearTicks, peak } from "../../lib/chart/scale";
import { formatTime, niceStep, timeAxis } from "../../lib/chart/timeAxis";
import {
  clampView,
  fractionOf,
  fullView,
  indexAt,
  isZoomed,
  panBy,
  selectRange,
  windowSpanPs,
  zoomAbout,
} from "../../lib/chart/view";
import type { SampleTimes, View } from "../../lib/chart/view";

export type Series = {
    id: string;
  label: string;
  color: string;
    dashed?: boolean;
    values: readonly (number | undefined)[];
};

const DASH = "5 3";

// bottom carries the tick labels AND the axis title under them.
const MARGIN = { top: 10, right: 12, bottom: 34, left: 48 } as const;

const WHEEL_ZOOM = 1.18;

function useMeasuredWidth(fallback: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      // Only a real width: a zero would divide every scale by nothing and draw a
      // chart of NaN widths, which renders as an empty box rather than an error.
      if (measured > 0) setWidth(measured);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function seriesGeometry(
  series: readonly Series[],
  x: (value: number) => number,
  y: (value: number) => number,
  baseline: number,
): { line: string; area: string } | null {
  if (series.length === 0) return null;
  const shape = line<number | undefined>()
    .defined((value) => typeof value === "number" && Number.isFinite(value))
    .x((_, index) => x(index))
    .y((value) => y(value as number))
    .curve(curveMonotoneX);
  const fill = area<number | undefined>()
    .defined((value) => typeof value === "number" && Number.isFinite(value))
    .x((_, index) => x(index))
    .y0(baseline)
    .y1((value) => y(value as number))
    .curve(curveMonotoneX);
  const path = shape(series[0].values);
  if (path === null) return null;
  return { line: path, area: fill(series[0].values) ?? "" };
}

export type TimeSeriesProps = {
  series: readonly Series[];
  height?: number;
    times: SampleTimes;
    yAxisLabel?: string;
    xAxisTitle?: string;
  formatY?: (value: number) => string;
    reference?: { value: number; label: string };
    ariaLabel: string;
  emptyMessage: string;
};

export function TimeSeries({
  series,
  height = 108,
  times,
  yAxisLabel,
  xAxisTitle,
  formatY = (value) => value.toFixed(0),
  reference,
  ariaLabel,
  emptyMessage,
}: TimeSeriesProps) {
  const gradientId = useId();
  const [hostRef, width] = useMeasuredWidth(480);
  const [view, setView] = useState<View | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<number | null>(null);
        const drag = useRef<{ anchorFraction: number; pixels: number } | null>(null);
  const sampleCount = series.reduce((most, entry) => Math.max(most, entry.values.length), 0);
  const plotWidth = Math.max(80, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;

  const window = view === null ? fullView(sampleCount) : clampView(view, sampleCount);
  const visible = series.filter((entry) => !hidden.has(entry.id));
  const top = peak(visible.flatMap((entry) => entry.values));
        const ceiling = reference === undefined ? top : Math.max(top, reference.value);

  const reset = (): void => {
    setView(null);
    setCursor(null);
  };

  const onWheel = (event: React.WheelEvent): void => {
    if (sampleCount === 0) return;
    event.preventDefault();
    // The SVG's box starts at MARGIN.left, so a pointer at clientX maps to a
    // fraction of the PLOT only after that is taken off.
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - bounds.left - MARGIN.left) / plotWidth;
    if (event.shiftKey) {
      setView(panBy(window, sampleCount, event.deltaY > 0 ? 0.15 : -0.15));
      return;
    }
    setView(zoomAbout(window, sampleCount, fraction, event.deltaY > 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM));
  };

  const fractionFrom = (event: React.PointerEvent): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (event.clientX - bounds.left - MARGIN.left) / plotWidth;
  };

  const onPointerDown = (event: React.PointerEvent): void => {
    if (sampleCount === 0) return;
    drag.current = { anchorFraction: fractionFrom(event), pixels: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent): void => {
    if (sampleCount === 0) return;
    const fraction = fractionFrom(event);
    setCursor(indexAt(window, sampleCount, fraction, times));
    if (drag.current !== null) {
      drag.current.pixels = Math.abs(fraction - drag.current.anchorFraction) * plotWidth;
    }
  };

  const onPointerUp = (event: React.PointerEvent): void => {
    const gesture = drag.current;
    drag.current = null;
    if (gesture === null) return;
    const chosen = selectRange(
      window,
      sampleCount,
      gesture.anchorFraction,
      fractionFrom(event),
      gesture.pixels,
      plotWidth,
      times,
    );
    setView(chosen);
  };

  const toggle = (id: string): void => {
    setHidden((prior) => {
      const next = new Set(prior);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const body =
    sampleCount === 0 || visible.length === 0 ? (
      <div className="series-empty">{visible.length === 0 && sampleCount > 0 ? "Every series is hidden." : emptyMessage}</div>
    ) : (
      <Plot
        series={series}
        visible={visible}
        gradientId={gradientId}
        plotWidth={plotWidth}
        plotHeight={plotHeight}
        sampleCount={sampleCount}
        window={window}
        cursor={cursor}
        reference={reference}
        ceiling={ceiling}
        times={times}
        yAxisLabel={yAxisLabel}
        xAxisTitle={xAxisTitle}
        formatY={formatY}
        ariaLabel={ariaLabel}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          drag.current = null;
          setCursor(null);
        }}
      />
    );

  return (
    <div className="series-chart" ref={hostRef}>
      <div className="series-toolbar">
        <span className="series-hint">scroll to zoom · shift+scroll to pan · drag to select</span>
        {isZoomed(window, sampleCount) && (
          <button className="series-reset" type="button" onClick={reset}>
            reset zoom
          </button>
        )}
      </div>
      {body}
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((entry) => (
            <button
              type="button"
              className={`legend-item legend-toggle${hidden.has(entry.id) ? " off" : ""}`}
              key={entry.id}
              onClick={() => toggle(entry.id)}
              aria-pressed={!hidden.has(entry.id)}
            >
              <i
                style={
                  entry.dashed
                    ? { backgroundImage: `repeating-linear-gradient(90deg, ${entry.color} 0 3px, transparent 3px 5px)` }
                    : { backgroundColor: entry.color }
                }
              />
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Plot({
  series,
  visible,
  gradientId,
  plotWidth,
  plotHeight,
  sampleCount,
  window,
  cursor,
  reference,
  ceiling,
  times,
  yAxisLabel,
  xAxisTitle,
  formatY,
  ariaLabel,
  onWheel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
}: {
  series: readonly Series[];
  visible: readonly Series[];
  gradientId: string;
  plotWidth: number;
  plotHeight: number;
  sampleCount: number;
  window: View;
  cursor: number | null;
  reference: { value: number; label: string } | undefined;
  ceiling: number;
  times: SampleTimes;
  yAxisLabel: string | undefined;
    xAxisTitle: string | undefined;
  formatY: (value: number) => string;
  ariaLabel: string;
  onWheel(event: React.WheelEvent): void;
  onPointerDown(event: React.PointerEvent): void;
  onPointerMove(event: React.PointerEvent): void;
  onPointerUp(event: React.PointerEvent): void;
  onPointerLeave(): void;
}) {
        const domain: readonly [number, number] =
    reference === undefined
      ? headroom(ceiling)
      : [0, Math.max(reference.value, ceiling)];
  const span = window.to - window.from;
  const axisFromPs = times[window.from] ?? 0;
  const axisToPs = times[window.to - 1] ?? axisFromPs;
  const windowSpan = axisToPs - axisFromPs;
  const axis = timeAxis(axisFromPs, axisToPs, 5);

          const x = (index: number): number => {
    if (windowSpan === 0) return plotWidth / 2;
    const time = times[index];
    if (typeof time !== "number" || !Number.isFinite(time)) return 0;
    return ((time - axisFromPs) / windowSpan) * plotWidth;
  };
  const y = (value: number): number => {
    const [low, high] = domain;
    const range = high - low;
    return range <= 0 ? plotHeight : plotHeight - ((value - low) / range) * plotHeight;
  };

  const yTicks = linearTicks(y, domain, 3, formatY);
  const xTicks = axis.ticks.map((tick) => ({
    at: windowSpan === 0 ? plotWidth / 2 : ((tick.timePs - axisFromPs) / windowSpan) * plotWidth,
    label: tick.label,
  }));
  const geometry = seriesGeometry(visible, x, y, plotHeight);
  const clipId = `clip-${gradientId}`;
  const cursorAt = cursor === null ? null : fractionOf(window, sampleCount, cursor, times);
  const svgWidth = plotWidth + MARGIN.left + MARGIN.right;
  const svgHeight = plotHeight + MARGIN.top + MARGIN.bottom;

  return (
    <svg
      className="series-plot"
      width={svgWidth}
      height={svgHeight}
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      role="img"
      aria-label={ariaLabel}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={-MARGIN.top} width={plotWidth} height={plotHeight + MARGIN.top} />
        </clipPath>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={visible[0].color} stopOpacity={0.26} />
          <stop offset="100%" stopColor={visible[0].color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <g transform={`translate(${MARGIN.left} ${MARGIN.top})`}>
        {yTicks.map((tick) => (
          <g key={`y-${tick.value}`}>
            <line className="series-gridline" x1={0} x2={plotWidth} y1={tick.at} y2={tick.at} />
            <text className="series-axis-label" x={-6} y={tick.at} dy="0.32em" textAnchor="end">
              {tick.label}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {geometry !== null && (
            <>
              <path className="series-fill" d={geometry.area} fill={`url(#${gradientId})`} />
              <path
                className="series-line"
                d={geometry.line}
                stroke={visible[0].color}
                strokeDasharray={visible[0].dashed ? DASH : undefined}
              />
            </>
          )}
          {visible.slice(1).map((entry) => {
            const shape = line<number | undefined>()
              .defined((value) => typeof value === "number" && Number.isFinite(value))
              .x((_, index) => x(index))
              .y((value) => y(value as number))
              .curve(curveMonotoneX)(entry.values);
            return shape === null ? null : (
              <path
                key={entry.id}
                className="series-line"
                d={shape}
                stroke={entry.color}
                strokeDasharray={entry.dashed ? DASH : undefined}
              />
            );
          })}
          {cursorAt !== null && (
            <>
              <line className="series-crosshair" x1={cursorAt * plotWidth} x2={cursorAt * plotWidth} y1={0} y2={plotHeight} />
              {visible.map((entry) => {
                const value = entry.values[cursor ?? 0];
                if (typeof value !== "number" || !Number.isFinite(value)) return null;
                return (
                  <circle
                    key={entry.id}
                    className="series-cursor-dot"
                    cx={cursorAt * plotWidth}
                    cy={y(value)}
                    r={2.5}
                    fill={entry.color}
                  />
                );
              })}
            </>
          )}
        </g>
        {reference !== undefined && (
          <>
            <line
              className="series-reference"
              x1={0}
              x2={plotWidth}
              y1={y(reference.value)}
              y2={y(reference.value)}
            />
            <text className="series-reference-label" x={plotWidth - 2} y={y(reference.value) - 3} textAnchor="end">
              {reference.label}
            </text>
          </>
        )}
        <line className="series-axis" x1={0} x2={plotWidth} y1={plotHeight} y2={plotHeight} />
        {xTicks.map((tick, position) => (
          <text
            key={`x-${tick.label}-${tick.at}`}
            className="series-axis-label"
            x={tick.at}
            y={plotHeight + 15}
            textAnchor={position === 0 ? "start" : position === xTicks.length - 1 ? "end" : "middle"}
          >
            {tick.label}
          </text>
        ))}
        {/* The unit, once, on the axis: repeating it on every tick is what makes a
            nanosecond axis eight digits wide, and a heading that ends ", MiB" reads
            as part of the title rather than as the axis it belongs to. */}
        <text className="series-axis-title" x={plotWidth / 2} y={plotHeight + 15} dy="0.9em" textAnchor="middle">
          {xAxisTitle === undefined ? axis.title : `${xAxisTitle} (${axis.unit.short})`}
        </text>
        {yAxisLabel !== undefined && (
          <text
            className="series-axis-title"
            transform={`translate(${-MARGIN.left + 4} ${plotHeight / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {yAxisLabel}
          </text>
        )}
      </g>
      {cursor !== null && cursorAt !== null && (
        <CursorReadout
          x={MARGIN.left + cursorAt * plotWidth}
          y={MARGIN.top}
          plotWidth={svgWidth - MARGIN.left - MARGIN.right}
          at={formatTime(times[cursor] ?? axisFromPs, axis.unit, niceStep(windowSpan / 5) || windowSpan || 1)}
          rows={visible.map((entry) => {
            const value = entry.values[cursor];
            return {
              label: entry.label,
              color: entry.color,
              text: typeof value === "number" && Number.isFinite(value) ? formatY(value) : "—",
            };
          })}
        />
      )}
    </svg>
  );
}

function CursorReadout({
  x,
  y,
  plotWidth,
  at,
  rows,
}: {
  x: number;
  y: number;
  plotWidth: number;
    at: string;
  rows: readonly { label: string; color: string; text: string }[];
}) {
  const width = 132;
  const height = 16 + rows.length * 13;
  // Flipped against the MEASURED plot width rather than a constant: a readout that
  // leaves the chart on a wide pane is worse than no readout at all.
  const flip = x + width + 12 > MARGIN.left + plotWidth;
  return (
    <g className="series-readout" transform={`translate(${flip ? x - width - 8 : x + 8} ${y})`}>
      <rect className="series-readout-bg" width={width} height={height} rx={3} />
      <text className="series-readout-title" x={7} y={11}>
        {at}
      </text>
      {rows.map((row, index) => (
        <g key={row.label} transform={`translate(0 ${16 + index * 13})`}>
          <circle cx={9} cy={5} r={3} fill={row.color} />
          <text className="series-readout-row" x={17} y={8}>
            {row.label}
          </text>
          <text className="series-readout-value" x={width - 7} y={8} textAnchor="end">
            {row.text}
          </text>
        </g>
      ))}
    </g>
  );
}
