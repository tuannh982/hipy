import table from "../../../toolchain/boundaries.json";

// The compile-time and launch-time rejections of the v1 playground, read from the
// one table the negative compile suite asserts against.
//
// toolchain/boundaries.json is the only writer. The enforcement sites -- the shim's
// headers, the harness's launch check -- do not read it: the strings are checked
// against them, and a mismatch is corrected in the row. That is what makes a row
// safe to render as a claim on screen.
//
// This module exists so both components that read the table share one import.
export type ToolchainBoundary = {
  /** The stable key a caller looks a row up by when it has no fixture to name it after. */
  id: string;
  /** A file in toolchain/tests/cuda/ for phase "compile", empty for phase "launch". */
  fixture: string;
  /** The stable prefix of the diagnostic this rejection produces. */
  message: string;
  label: string;
  detail: string;
  phase: string;
};

export const toolchainBoundaries: readonly ToolchainBoundary[] = table.boundaries;

// Every row that fails at compile, in table order. Compile rather than launch
// because a launch-time rejection is invisible until a kernel is already running.
export function compileRejections(): readonly ToolchainBoundary[] {
  return toolchainBoundaries.filter((boundary) => boundary.phase === "compile");
}

// One row by id, or null for an id the table does not have.
export function boundaryById(id: string): ToolchainBoundary | null {
  return toolchainBoundaries.find((boundary) => boundary.id === id) ?? null;
}

/**
 * The compile-time rejections as one line, for the editor footer.
 *
 * The labels, not the diagnostics: the footer is a summary a reader sees before
 * writing anything, and the About tab prints the sentences in full. It is a
 * rendering of those rows, not a second claim about the toolchain.
 */
export function compileRejectionSummary(): string {
  return `Rejected at compile: ${compileRejections().map((boundary) => boundary.label).join(", ")}`;
}