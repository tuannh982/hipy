import { useState } from "react";
import { ldsSeverity, selectLdsModel } from "../lib/ldsModel";
import type { LdsModel, LdsPattern } from "../lib/ldsModel";
import type { LdsAnalysisData } from "../lib/protocol";
import {
  ldsAccessSentence,
  ldsBankColumns,
  ldsBankCountsReported,
  ldsBankInfoNote,
  ldsBankMapNote,
  ldsBankOccupancy,
  ldsBankTooltip,
  ldsCleanNote,
  ldsDegreeSentence,
  ldsLaneAddrLabel,
  ldsLaneBankAddrs,
  ldsLaneBytes,
  ldsLaneCount,
  ldsLanePeersLabel,
  ldsLanePhaseLabel,
  ldsLaneTableNote,
  ldsListNote,
  ldsPatternSource,
  ldsOpcodeSentence,
  ldsPhaseBankKey,
  ldsPhaseBankLanes,
  ldsPhaseStripNote,
  ldsRowTooltip,
  ldsSeverityLegend,
  ldsStatsNote,
  ldsSummaryLines,
  selectLdsPattern,
  LDS_BANK_COUNT,
  LDS_LANE_COLUMNS,
  LDS_LIST_COLUMNS,
} from "../lib/ldsView";
import type { LdsBankCell, LdsBankColumn } from "../lib/ldsView";
import { barScale, categoryScale } from "../lib/chart/scale";

export const LDS_PALETTE = { bank: "#5c5c5c", conflict: "#ef4444", phaseRule: "#2b2b2b" } as const;

// The phase segments on the lane axis, in draw order. Not severity colours: a phase
// is a scheduling group, and its degree is written beside it in the legend.
const PHASE_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24"] as const;

const MAP_WIDTH = 640;
// The bar area. Columns are drawn upward from the bottom of it, scaled against the
// deepest bank in this access, so the tallest column is always the degree.
const PLOT_HEIGHT = 48;
// Reserved at the top of the plot for the count written above the deepest column.
const COUNT_BAND = 10;
const COUNT_LABEL_TOP = 8;
const BAR_AREA = PLOT_HEIGHT - COUNT_BAND;
const BANK_LABEL_BASELINE = PLOT_HEIGHT + 12;
const AXIS_Y = PLOT_HEIGHT + 24;
const MAP_HEIGHT = AXIS_Y + 14;
// The right margin, for the rotated bank axis name, outside MAP_WIDTH so it cannot
// overlap a column or the lane strip.
const AXIS_GUTTER = 14;

function BankMap({
  pattern,
  columns,
  cells,
}: {
  pattern: LdsPattern;
  columns: LdsBankColumn[];
  // The lane view, for the tooltips only: a column says how deep a bank is, and
  // naming the lanes behind it is what makes a reader able to go and look.
  cells: LdsBankCell[];
}) {
                const cellWidth = MAP_WIDTH / LDS_BANK_COUNT;
  const banks = categoryScale(LDS_BANK_COUNT, MAP_WIDTH);
  const laneCount = ldsLaneCount(pattern);
  const lanes = categoryScale(laneCount, MAP_WIDTH);
  const laneX = (lane: number): number => lanes(lane) ?? 0;
  const deepest = columns.reduce((most, column) => Math.max(most, column.addrs), 0);
  const depthToY = barScale(deepest, BAR_AREA);
  const reported = ldsBankCountsReported(pattern);
  // The depth is the number the picture is for, so it is in the accessible name.
  const ariaLabel = reported
    ? `Bank conflicts for ${pattern.name}: the deepest bank holds ${deepest} distinct ${deepest === 1 ? "address" : "addresses"}`
    : `Bank map for ${pattern.name}: this analysis reported no per-bank address counts`;

  return (
    <svg className="lds-bankmap" viewBox={`0 0 ${MAP_WIDTH + AXIS_GUTTER} ${MAP_HEIGHT + 6}`} role="img" aria-label={ariaLabel}>
      {columns.map((column) => {
        const x = banks(column.bank) ?? 0;
        const height = column.height * BAR_AREA;
        // The wave-wide lane list is appended because that is what a MAP cell is for:
        // the map spans the whole wave, while the addresses are scoped to one phase.
        const cell = cells[column.bank];
        const across = cell === undefined || cell.lanes.length === 0
          ? ""
          : `; ${cell.lanes.length} ${cell.lanes.length === 1 ? "lane" : "lanes"} land here across all phases: ${cell.lanes.map((lane) => lane.lane).join(", ")}`;
        const title = !reported
          ? `bank ${column.bank}: this analysis reported no per-bank address counts`
          : `${ldsBankTooltip(pattern, column)}${across}`;
        return (
          <g key={column.bank}>
            {column.addrs > 0 && (
              <rect
                className={column.conflicted ? "lds-bank crowded" : "lds-bank"}
                x={x}
                y={PLOT_HEIGHT - height}
                width={(banks.bandwidth() || cellWidth) - 1}
                height={height}
                rx={2}
                fill={column.conflicted ? LDS_PALETTE.conflict : LDS_PALETTE.bank}
                opacity={column.conflicted ? 0.9 : 0.75}
              >
                <title>{title}</title>
              </rect>
            )}
            {column.conflicted && (
              <text
                x={x + (banks.bandwidth() || cellWidth) / 2}
                y={Math.max(COUNT_LABEL_TOP, depthToY(column.height) - 2)}
                textAnchor="middle"
                className="lds-bank-count"
              >
                {column.addrs}
              </text>
            )}
            <text x={x + (banks.bandwidth() || cellWidth) / 2} y={BANK_LABEL_BASELINE} textAnchor="middle" className="lds-bank-label">
              {column.bank}
            </text>
          </g>
        );
      })}
      <text
        className="lds-axis-label"
        x={MAP_WIDTH + AXIS_GUTTER / 2 + 2}
        y={BANK_LABEL_BASELINE - 3}
        textAnchor="middle"
        transform={`rotate(-90 ${MAP_WIDTH + AXIS_GUTTER / 2 + 2} ${BANK_LABEL_BASELINE - 3})`}
      >
        bank
      </text>
      <line x1={0} y1={AXIS_Y} x2={MAP_WIDTH} y2={AXIS_Y} stroke={LDS_PALETTE.phaseRule} strokeWidth={1} />
      {pattern.phases.map((phase, index) => {
        const first = laneX(phase.firstLane);
        const last = phase.lastLane + 1 < laneCount ? laneX(phase.lastLane + 1) : MAP_WIDTH;
        return (
          <rect
            key={index}
            className="lds-phase-segment"
            x={first}
            y={AXIS_Y - 3}
            width={Math.max(2, last - first)}
            height={6}
            rx={2}
            fill={PHASE_COLORS[index % PHASE_COLORS.length]}
            opacity={0.85}
          >
            <title>{`phase ${index}: lanes ${phase.firstLane}–${phase.lastLane}, ${phase.lanes.length} active, degree ${phase.degree}. Only lanes inside one phase can collide, so this phase costs ${phase.degree} ${phase.degree === 1 ? "cycle" : "cycles"}.`}</title>
          </rect>
        );
      })}
      <text x={0} y={MAP_HEIGHT} className="lds-axis-label">lane 0</text>
      <text x={MAP_WIDTH} y={MAP_HEIGHT} textAnchor="end" className="lds-axis-label">lane {laneCount - 1}</text>
      {reported && (
        <text x={MAP_WIDTH / 2} y={MAP_HEIGHT} textAnchor="middle" className="lds-axis-label">
          height = distinct addresses per bank
        </text>
      )}
    </svg>
  );
}

function PcCell({ pattern, onJump }: { pattern: LdsPattern; onJump: ((line: number) => void) | undefined }) {
  const source = ldsPatternSource(pattern);
  const address = `0x${pattern.pc.toString(16)}`;
  if (source === null || onJump === undefined) {
    return <span className="lds-row-pc">pc {address}</span>;
  }
  const label = `Jump to ${source.file} line ${source.line}`;
  return (
    <span
      className="lds-row-pc lds-pc-link"
      role="button"
      tabIndex={0}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onJump(source.line);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onJump(source.line);
      }}
    >
      pc {address} ↗
    </span>
  );
}

export function LdsInspector({
  lds,
  targetArch,
  onJumpToLine,
}: {
  lds: LdsAnalysisData | null;
  targetArch: string | null;
    onJumpToLine?: (line: number) => void;
}) {
                  const model = lds ? selectLdsModel(lds, targetArch) : null;
  // A run has not happened yet, as opposed to a run that reported no LDS at all:
  // the first is an absence of data and the second is a result.
  if (lds === null) {
    return <div className="panel-empty">Bank conflicts are computed from the __shared__ accesses a run actually performed. Run a kernel that reads or writes __shared__ memory to see them here.</div>;
  }
  // An empty pattern list is a kernel with no LDS, which is a finding and not a
  // failure.
  if (model === null) {
    return <div className="panel-empty">This kernel performed no LDS accesses, so there are no bank conflicts to report. That is the whole result, not a missing one.</div>;
  }
  return <LdsPanel model={model} onJumpToLine={onJumpToLine} />;
}

function LdsPanel({ model, onJumpToLine }: { model: LdsModel; onJumpToLine?: (line: number) => void }) {
  const [selected, setSelected] = useState(0);
  // A run replaces the analysis under a tab that may still hold the index of a row
  // that no longer exists, so the index is clamped rather than trusted.
  const pattern = selectLdsPattern(model, selected);
  if (pattern === null) {
    return <div className="panel-empty">This kernel performed no LDS accesses, so there are no bank conflicts to report. That is the whole result, not a missing one.</div>;
  }

  const severity = ldsSeverity(pattern.degree);
  const cleanNote = ldsCleanNote(model);
  const statsNote = ldsStatsNote(model);
  const cells = ldsBankOccupancy(pattern);
  const columns = ldsBankColumns(pattern);
  const countsReported = ldsBankCountsReported(pattern);
  const deepestBank = columns.reduce((most, column) => (column.addrs > most.addrs ? column : most), columns[0]);
  const unphasedLanes = pattern.lanes.filter((lane) => lane.phase < 0 || lane.phase >= pattern.phases.length).length;
  // The table groups by phase and bank; the map's own cells group by bank across the
  // whole wave, which is right for a tooltip and wrong for a table.
  const phaseBanks = ldsPhaseBankLanes(pattern);
  // One number for the whole table: every lane of one instruction moves the same footprint.
  const laneBytes = ldsLaneBytes(pattern);

  return (
    <div className="lds-panel">
      <div className="lds-summary">
        {ldsSummaryLines(model).map((line) => <span key={line}>{line}</span>)}
      </div>

      {/* The geometry the whole panel is measured against, stated once. */}
      <p className="lds-bank-info">{ldsBankInfoNote()}</p>

      {model.approximate.map((note) => <p key={note} className="lds-approximate">{note}</p>)}
      {statsNote !== null && <p className="lds-rep-note">{statsNote}</p>}

      {cleanNote !== null && <div className="lds-clean">{cleanNote}</div>}

      <p className="table-note lds-list-note">{ldsListNote(model)}</p>

      {/* The columns, named. Explanations live in the title attributes so the headers
          stay headers; the legend below carries what a hover cannot. */}
      <div className="lds-list-head">
        {LDS_LIST_COLUMNS.map((column) => (
          <span key={column.key} className={`lds-head-${column.key}`} title={column.help}>{column.label}</span>
        ))}
      </div>
      <ul className="lds-list">
        {model.patterns.map((candidate, index) => {
          const grade = ldsSeverity(candidate.degree);
          return (
            <li key={`${candidate.pc}-${candidate.name}-${index}`}>
              <button
                type="button"
                aria-pressed={index === selected}
                className={index === selected ? "lds-row active" : "lds-row"}
                onClick={() => setSelected(index)}
                title={ldsRowTooltip(candidate)}
              >
                <span className="lds-row-degree" style={{ backgroundColor: grade.color }}>{candidate.degree > 0 ? candidate.degree : "–"}</span>
                <span className="lds-row-name">{candidate.name}</span>
                <span className="lds-row-stride">stride {candidate.stride} B</span>
                <PcCell pattern={candidate} onJump={onJumpToLine} />
                <span className="lds-row-count">×{candidate.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="chart-legend lds-degree-legend">
        {ldsSeverityLegend().map((band) => (
          <span className="legend-item" key={band.label}>
            <i style={{ backgroundColor: band.color }} />
            {band.label}
          </span>
        ))}
      </div>

      <div className="lds-detail">
        <div className="section-title">
          <div>
            <span className="eyebrow">{pattern.isRead ? "Read" : "Write"} · {pattern.count} executions</span>
            <h2>{pattern.name} at pc 0x{pattern.pc.toString(16)}</h2>
          </div>
          <span className="lds-verdict" style={{ color: severity.color }}>{severity.label}</span>
        </div>

        {/* The line table's answer, as a control. Absent, with the reason, when there is none. */}
        {(() => {
          const source = ldsPatternSource(pattern);
          if (source === null) {
            return (
              <p className="lds-flag">
                This kernel's code object carried no line table, so its program counter cannot be attributed to a
                source line. Everything else on this page is measured; this one row is not available.
              </p>
            );
          }
          return (
            <div className="lds-source">
              <span className="lds-source-where">
                {`${source.file}:${source.line} — attributed by the code object's line table, at -O2`}
              </span>
              {onJumpToLine !== undefined && (
                <button type="button" className="button button-small" onClick={() => onJumpToLine(source.line)}>
                  {`Jump to line ${source.line}`}
                </button>
              )}
            </div>
          );
        })()}

        {/* In the order a reader meets the questions; each defers to ldsBankInfoNote for geometry. */}
        <p className="lds-access">{ldsAccessSentence(pattern)}</p>
        <p className="lds-degree">{ldsDegreeSentence(pattern)}</p>
        <p className="lds-access">{ldsOpcodeSentence(pattern)}</p>
        {!pattern.uniformStride && (
          <p className="lds-flag">This access does not step uniformly, so its stride is the first phase's and the degree may differ between phases.</p>
        )}
        {/* No instance list is rendered, and no truncation flag either: the
            analyzer's per-pattern instance list is a join back to the trace this
            panel does not hold, so telling a reader it is truncated would point at
            a list they cannot see. */}

        {pattern.lanes.length === 0 ? (
          <p className="lds-flag">No per-lane bank map was recorded for this access.</p>
        ) : (
          <>
            <p className="table-note lds-map-note">{ldsBankMapNote()}</p>
            <BankMap pattern={pattern} columns={columns} cells={cells} />
            <div className="chart-legend">
              {countsReported && (
                <>
                  <span className="legend-item">
                    <i style={{ backgroundColor: LDS_PALETTE.conflict }} />
                    conflicted bank: more than one address in its busiest phase, so that phase costs that many cycles
                  </span>
                  <span className="legend-item">
                    <i style={{ backgroundColor: LDS_PALETTE.bank }} />
                    one address only: a broadcast or a lone lane, served in one cycle
                  </span>
                  <span className="legend-item">
                    {`height: distinct addresses per bank in its busiest phase · deepest is bank ${deepestBank.bank} at ${deepestBank.addrs}`}
                  </span>
                </>
              )}
              {pattern.phases.map((phase, index) => (
                <span className="legend-item" key={index}>
                  <i style={{ backgroundColor: PHASE_COLORS[index % PHASE_COLORS.length] }} />
                  {`phase ${index} · lanes ${phase.firstLane}–${phase.lastLane} · ${phase.lanes.length} active · degree ${phase.degree}`}
                </span>
              ))}
              {pattern.phases.length === 0 && <span className="legend-item">no phases were recorded</span>}
            </div>
            <p className="lds-rep-note">{ldsPhaseStripNote(pattern)}</p>
            {!countsReported && (
              <p className="lds-flag">
                This analysis reported no per-bank address counts, so the map is empty. That is a missing measurement,
                not a conflict-free access: the degree above is the only bank information here.
              </p>
            )}
            {/* Only when there is something to add; the plain count is in the table's note. */}
            {unphasedLanes > 0 && (
              <p className="lds-rep-note">
                {`${unphasedLanes} of ${pattern.lanes.length} active lanes match no phase range, so the map draws them but cannot say which phase serves them.`}
              </p>
            )}
            <p className="table-note lds-table-note">{ldsLaneTableNote(pattern)}</p>
            <div className="table-wrap">
              <table className="lds-lanes">
                <thead>
                  <tr>
                    {LDS_LANE_COLUMNS.map((column) => (
                      <th key={column.key} title={column.help}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pattern.lanes.map((lane) => {
                    // Highlighted on the address count rather than the lane count, so
                    // the table agrees with the map.
                    const column = columns[lane.bank];
                    const peers = (phaseBanks.get(ldsPhaseBankKey(lane.phase, lane.bank)) ?? [])
                      .filter((other) => other.lane !== lane.lane)
                      .map((other) => other.lane);
                    const addrs = ldsLaneBankAddrs(pattern, lane);
                    return (
                      <tr key={lane.lane} className={column !== undefined && column.conflicted ? "lds-crowded-row" : undefined}>
                        <td>{lane.lane}</td>
                        <td className="lds-lane-addr">{ldsLaneAddrLabel(lane)}</td>
                        <td>{laneBytes}</td>
                        <td>{lane.bank}</td>
                        <td>{ldsLanePhaseLabel(lane, pattern.phases)}</td>
                        <td>{ldsLanePeersLabel(peers)}</td>
                        <td>{addrs === null ? "—" : addrs}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
