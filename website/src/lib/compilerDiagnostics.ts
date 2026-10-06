export type CompilerDiagnostic = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: "error" | "warning";
};

function isPositiveFiniteInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0 && Number.isFinite(value);
}

export function parseClangDiagnostics(output: string): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const pattern = /^(.+):(\d+):(\d+):\s+(fatal error|error|warning):\s+(.+)$/gm;
  for (const match of output.matchAll(pattern)) {
    const startLineNumber = Number(match[2]);
    const startColumn = Number(match[3]);
    if (!isPositiveFiniteInteger(startLineNumber) || !isPositiveFiniteInteger(startColumn)) continue;
    diagnostics.push({
      startLineNumber,
      startColumn,
      endLineNumber: startLineNumber,
      endColumn: startColumn + 1,
      message: match[5],
      severity: match[4] === "warning" ? "warning" : "error",
    });
  }
  return diagnostics;
}
