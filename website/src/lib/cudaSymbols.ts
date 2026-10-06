// Jump-to-definition for a .cu file.
//
// There is no C++ language service here (see cudaLanguage.ts for why), so go to
// definition is answered by indexing the one file in front of the reader plus a
// synthetic declaration of the CUDA API. That covers a macro, a kernel or function
// defined later than it is called, and a runtime call or intrinsic.
//
// Recall is deliberately low: every pattern is anchored and conservative, because
// a wrong jump is worse than no jump.

import { CUDA_DOCS, CUDA_KEYWORDS, CUDA_RUNTIME } from "./cudaLanguage";

export type SymbolKind = "macro" | "kernel" | "function" | "runtime";

export type Symbol = {
  name: string;
  kind: SymbolKind;
  /** One-based, as Monaco wants. */
  line: number;
  /** One-based, inclusive. */
  column: number;
  endColumn: number;
};

/** The URI of the synthetic API document the runtime symbols live in. */
export const CUDA_RUNTIME_URI = "inmemory://model/hipy-cuda-runtime.h";

/**
 * `#define NAME`, the position of the name itself.
 *
 * Anchored to a line start so a `#define` inside a string or a comment is not
 * picked up, and the range is the NAME rather than the whole line.
 */
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

/**
 * Function and kernel DEFINITIONS -- a parameter list followed by a body brace.
 *
 * The trailing `{` is what separates a definition from a call or a declaration,
 * and it is why a launch like `matmulConflict<<<1, 64>>>(a, b, c)` is not
 * indexed as one. `__global__` and `__device__` are matched on their own so the
 * name is not captured as the return type.
 */
function indexFunctions(source: string): Symbol[] {
  const found: Symbol[] = [];
  const qualified = /^[ \t]*(?:extern\s+"C"\s*)?(?:__global__|__device__|__host__)\s+[A-Za-z_][\w:<>]*[*\s]*\**\s*([A-Za-z_]\w*)\s*\(/gm;
  for (let match = qualified.exec(source); match !== null; match = qualified.exec(source)) {
    const line = source.slice(0, match.index).split("\n").length;
    const column = match[0].lastIndexOf(match[1]) + 1;
    found.push({ name: match[1], kind: match[0].includes("__global__") ? "kernel" : "function", line, column, endColumn: column + match[1].length });
  }

  // A plain `type name(...) {`, which is every host function in an example.
  // Anchored to a line start so a call inside a body is not matched, and requiring
  // the brace so a forward declaration is not indexed as a definition.
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

/**
 * Every symbol in the file, first definition winning for a name. A forward
 * declaration is where the reader wants to land.
 */
export function indexSource(source: string): Map<string, Symbol> {
  const index = new Map<string, Symbol>();
  for (const symbol of [...indexMacros(source), ...indexFunctions(source)]) {
    if (!index.has(symbol.name)) index.set(symbol.name, symbol);
  }
  return index;
}

/** Every CUDA API name, whether or not it has a note. */
function apiNames(): string[] {
  return [...new Set<string>([...CUDA_RUNTIME, ...CUDA_KEYWORDS])];
}

/**
 * A synthetic header declaring the CUDA API, generated from the same tables the
 * completion provider reads, so the three features cannot drift apart.
 *
 * The intrinsic signatures are deliberately vague (`int name(...);`) rather than
 * guessed: a wrong arity shown as a declaration is worse than none.
 */
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

/** Where each API name sits in the synthetic document, for the definition provider. */
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
