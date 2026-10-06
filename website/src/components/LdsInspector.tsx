import { useState } from "react";
import { ldsSeverity, selectLdsModel } from "../lib/ldsModel";
import type { LdsModel, LdsPattern } from "../lib/ldsModel";
import type { LdsAnalysisData } from "../lib/protocol";
import {
  ldsAccessSentence,
  ldsBankColumns,
  ldsBankCountsReported,
  ldsBankOccupancy,
  ldsCleanNote,
  ldsDegreeSentence,
  ldsLaneCount,
  ldsLanePhaseLabel,
  ldsStatsNote,
  ldsSummaryLines,
  selectLdsPattern,
  LDS_BANK_COUNT,
} from "../lib/ldsView";
import type { LdsBankCell, LdsBankColumn } from "../lib/ldsView";
import { barScale, categoryScale } from "../lib/chart/scale";

// The bank map's three colours. bank and phaseRule are the sheet's neutrals spelled
// out, because an SVG presentation attribute cannot read a custom property, so a
// theme change has a third place to edit here alongside styles.css and CudaEditor's
// Monaco colours.
//
// conflict stays red on purpose: it is a severity, and a reader has to be able to
// recognise a contended bank without learning a palette first.
export const LDS_PALETTE = { bank: "#333333", conflict: "#ef4444", phaseRule: "#2b2b2b" } as const;

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

/**
 * One access, as 32 bank columns over a lane axis.
 *
 * Each column's HEIGHT is the number of distinct addresses that bank saw in the
 * access's busiest phase, and a column is red exactly when that number is above
 * one. The count is written on every conflicted column, because the height is
 * scaled to this access and so says which is deeper but not by how much.
 *
 * Not drawn from the lanes in each bank: a 64-lane broadcast puts 64 lanes in one
 * bank at one address, and a lane count draws it as the worst case in the ISA.
 *
 * The axis below carries the phases, because a bank is only contended by lanes the
 * hardware serves together.
 */
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
  // Two d3 scales: a band scale for the 32 banks and the lane span below them, and a
  // linear one for how deep a bank is. The lane scale is a band scale because the
  // lane axis is discrete -- there is no lane 3.5.
  //
  // The depth scale starts at zero, which is the rule rather than a default: the
  // height of a column IS the number of addresses in the bank, so a non-zero
  // baseline would imply the ratio is something other than what it is.
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
    <svg className="lds-bankmap" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT + 6}`} role="img" aria-label={ariaLabel}>
      {columns.map((column) => {
        const x = banks(column.bank) ?? 0;
        const height = column.height * BAR_AREA;
        const cell = cells[column.bank];
        const phaseLabel = column.phase < 0 ? "" : ` in phase ${column.phase}`;
        const title = !reported
          ? `bank ${column.bank}: this analysis reported no per-bank address counts`
          : column.addrs === 0
            ? `bank ${column.bank}: no address in any phase`
            : `bank ${column.bank}: ${column.addrs} distinct ${column.addrs === 1 ? "address" : "addresses"}${phaseLabel}`
              + (cell === undefined || cell.lanes.length === 0
                ? ""
                : `; ${cell.lanes.length} ${cell.lanes.length === 1 ? "lane" : "lanes"}: ${cell.lanes.map((lane) => lane.lane).join(", ")}`);
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
            <title>{`phase ${index}: lanes ${phase.firstLane}–${phase.lastLane}, ${phase.lanes.length} active, degree ${phase.degree}`}</title>
          </rect>
        );
      })}
      <text x={0} y={MAP_HEIGHT} className="lds-axis-label">lane 0</text>
      <text x={MAP_WIDTH} y={MAP_HEIGHT} textAnchor="end" className="lds-axis-label">lane {laneCount - 1}</text>
      {reported && (
        <text x={MAP_WIDTH / 2} y={MAP_HEIGHT} textAnchor="middle" className="lds-axis-label">
          column height = distinct addresses in that bank
        </text>
      )}
    </svg>
  );
}

export function LdsInspector({ lds, targetArch }: { lds: LdsAnalysisData | null; targetArch: string | null }) {
  // App.tsx already ran selectLdsModel on this same object to decide whether to
  // render the tab, so this is the second call on the same data. Left as is: the
  // selector is pure and the alternative is threading a model through a prop that
  // has to survive lds === null anyway.
  //
  // The arch is passed in rather than read from a module global because the model
  // this call produces renders its own caveats. It is nullable because the catalog
  // it comes from is, and selectLdsModel renders that as prose naming no arch.
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
  return <LdsPanel model={model} />;
}

function LdsPanel({ model }: { model: LdsModel }) {
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

  return (
    <div className="lds-panel">
      <div className="lds-summary">
        {ldsSummaryLines(model).map((line) => <span key={line}>{line}</span>)}
      </div>

      {model.approximate.map((note) => <p key={note} className="lds-approximate">{note}</p>)}
      {statsNote !== null && <p className="lds-rep-note">{statsNote}</p>}

      {cleanNote !== null && <div className="lds-clean">{cleanNote}</div>}

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
              >
                <span className="lds-row-degree" style={{ backgroundColor: grade.color }}>{candidate.degree > 0 ? candidate.degree : "–"}</span>
                <span className="lds-row-name">{candidate.name}</span>
                <span className="lds-row-stride">stride {candidate.stride} B</span>
                <span className="lds-row-pc">pc 0x{candidate.pc.toString(16)}</span>
                <span className="lds-row-count">×{candidate.count}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="lds-detail">
        <div className="section-title">
          <div>
            <span className="eyebrow">{pattern.isRead ? "Read" : "Write"} · {pattern.count} executions</span>
            <h2>{pattern.name} at pc 0x{pattern.pc.toString(16)}</h2>
          </div>
          <span className="lds-verdict" style={{ color: severity.color }}>{severity.label}</span>
        </div>

        <p className="lds-access">{ldsAccessSentence(pattern)}</p>
        <p className="lds-degree">{ldsDegreeSentence(pattern)}</p>
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
            <BankMap pattern={pattern} columns={columns} cells={cells} />
            <div className="chart-legend">
              {countsReported && (
                <span className="legend-item">
                  {`column height: distinct addresses in one bank in one phase · deepest is bank ${deepestBank.bank} at ${deepestBank.addrs}`}
                </span>
              )}
              {pattern.phases.map((phase, index) => (
                <span className="legend-item" key={index}>
                  <i style={{ backgroundColor: PHASE_COLORS[index % PHASE_COLORS.length] }} />
                  {`phase ${index} · lanes ${phase.firstLane}–${phase.lastLane} · ${phase.lanes.length} active · degree ${phase.degree}`}
                </span>
              ))}
              {pattern.phases.length === 0 && <span className="legend-item">no phases were recorded</span>}
            </div>
            {!countsReported && (
              <p className="lds-flag">
                This analysis reported no per-bank address counts, so the map is empty. That is a missing measurement,
                not a conflict-free access: the degree above is the only bank information here.
              </p>
            )}
            <p className="lds-rep-note">
              {unphasedLanes === 0
                ? `${pattern.lanes.length} active lanes across ${LDS_BANK_COUNT} banks.`
                : `${unphasedLanes} of ${pattern.lanes.length} active lanes match no phase range, so the map draws them but cannot say which phase serves them.`}
            </p>
            <div className="table-wrap">
              <table className="lds-lanes">
                <thead>
                  <tr><th>Lane</th><th>Bank</th><th>Phase</th><th>Shares its bank with</th></tr>
                </thead>
                <tbody>
                  {pattern.lanes.map((lane) => {
                    const cell = cells[lane.bank];
                    // Highlighted on the address count rather than the lane count, so
                    // the table agrees with the map.
                    const column = columns[lane.bank];
                    return (
                      <tr key={lane.lane} className={column !== undefined && column.conflicted ? "lds-crowded-row" : undefined}>
                        <td>{lane.lane}</td>
                        <td>{lane.bank}</td>
                        <td>{ldsLanePhaseLabel(lane, pattern.phases)}</td>
                        <td>{cell === undefined ? "—" : cell.lanes.map((other) => other.lane).join(", ")}</td>
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
