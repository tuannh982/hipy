export type ExampleDefinition = {
  id: string;
  source: string;
  contentHash?: string;
};

export function contentHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function exampleIdFromGlobKey(globKey: string): string {
  const fileName = globKey.slice(globKey.lastIndexOf("/") + 1);
  return fileName.replace(/\.cu$/, "");
}

// The picker is the only menu a user ever sees, so the label has to carry the
// lesson: deriving one from the id alone renders "Matmul Conflict" and "Matmul
// Padded", two labels that never say what separates the kernels, which is the exact
// distinction the derivation erased. The manifest's title carries it ("Matrix
// Multiply, Row Stride 32"), beside the id and file it describes in
// simulator/testdata/fixtures.json.
//
// A title is optional and the derivation stays as the fallback, so a blank one
// still gets a label rather than an empty picker entry.
export function exampleLabel(id: string, title?: string | null): string {
  const named = title?.trim();
  if (named) return named;
  return id
    .split("-")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
    .trim();
}

export function selectedExampleId(source: string, examples: readonly ExampleDefinition[]): string | null {
  const hash = contentHash(source);
  return examples.find((example) => example.source === source || (example.contentHash !== undefined && example.contentHash === hash))?.id ?? null;
}
