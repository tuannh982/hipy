
import { CUDA_DOCS, CUDA_KEYWORDS, CUDA_RUNTIME } from "./cudaLanguage";

export type SymbolKind = "macro" | "kernel" | "function" | "runtime";

export type Symbol = {
  name: string;
  kind: SymbolKind;
    line: number;
    column: number;
  endColumn: number;
};

export const CUDA_RUNTIME_URI = "inmemory://model/hipy-cuda-runtime.h";

function indexMacros(source: string): Symbol[] {
  const found: Symbol[] = [];
  const pattern = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const line = source.slice(0, match.index).split("\n").length;
    // The name starts after `#define` and its whitespace.
    const column = match[0].length - match[1].length + 1;
    found.push({ name: match[1], kind: "macro", line, column, endColumn: column + match[1].length });
  }
  return found;
}

function indexFunctions(source: string): Symbol[] {
  const found: Symbol[] = [];
  const qualified = /^[ \t]*(?:extern\s+"C"\s*)?(?:__global__|__device__|__host__)\s+[A-Za-z_][\w:<>]*[*\s]*\**\s*([A-Za-z_]\w*)\s*\(/gm;
  for (let match = qualified.exec(source); match !== null; match = qualified.exec(source)) {
    const line = source.slice(0, match.index).split("\n").length;
    const column = match[0].lastIndexOf(match[1]) + 1;
    found.push({ name: match[1], kind: match[0].includes("__global__") ? "kernel" : "function", line, column, endColumn: column + match[1].length });
  }

        const plain = /^[ \t]*(?:static\s+|inline\s+|extern\s+)*(?:[A-Za-z_][\w:<>]*[*\s]+)+\**\s*([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:const\s*)?\{/gm;
  for (let match = plain.exec(source); match !== null; match = plain.exec(source)) {
    const name = match[1];
    if (new Set(["if", "for", "while", "switch", "catch", "return"]).has(name)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    const column = match[0].lastIndexOf(name) + 1;
    if (found.some((entry) => entry.name === name)) continue;
    found.push({ name, kind: "function", line, column, endColumn: column + name.length });
  }
  return found;
}

export function indexSource(source: string): Map<string, Symbol> {
  const index = new Map<string, Symbol>();
  for (const symbol of [...indexMacros(source), ...indexFunctions(source)]) {
    if (!index.has(symbol.name)) index.set(symbol.name, symbol);
  }
  return index;
}

function apiNames(): string[] {
  return [...new Set<string>([...CUDA_RUNTIME, ...CUDA_KEYWORDS])];
}

export function cudaRuntimeSource(): string {
  const lines = [
    // Synthetic HIP API declarations for the Playground's editor. Not a real
    // header: there is no HIP toolkit in the browser.
    "",
  ];
  for (const name of apiNames()) {
    const docs = CUDA_DOCS[name];
    if (docs !== undefined) lines.push(`// ${docs}`);
    lines.push(/^[a-z_]/.test(name) || name.startsWith("__") ? `int ${name}(...);` : `typedef int ${name};`);
  }
  return `${lines.join("\n")}\n`;
}

export function indexRuntime(source: string = cudaRuntimeSource()): Map<string, Symbol> {
  const index = new Map<string, Symbol>();
  const pattern = /^[ \t]*(?:int[ \t]+([A-Za-z_]\w*)\(\.\.\.\);|typedef[ \t]+int[ \t]+([A-Za-z_]\w*);)/gm;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const name = match[1] ?? match[2];
    if (name === undefined) continue;
    const line = source.slice(0, match.index).split("\n").length;
    const column = match[0].lastIndexOf(name) + 1;
    index.set(name, { name, kind: "runtime", line, column, endColumn: column + name.length });
  }
  return index;
}
