import table from "../../../toolchain/boundaries.json";

export type ToolchainBoundary = {
    id: string;
    fixture: string;
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

export function compileRejectionSummary(): string {
  return `Rejected at compile: ${compileRejections().map((boundary) => boundary.label).join(", ")}`;
}
