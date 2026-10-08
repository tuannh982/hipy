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

// reduction leads the picker. See buildExamples, in the next task, for why.
export const DEFAULT_EXAMPLE_ID = "reduction";

export function defaultExampleSource(examples: readonly ExampleDefinition[]): string {
  const fallback = examples.find((example) => example.id === DEFAULT_EXAMPLE_ID)?.source;
  if (fallback === undefined) {
    throw new Error(`default example ${DEFAULT_EXAMPLE_ID} is missing from src/examples`);
  }
  return fallback;
}

export type LabelledExample = ExampleDefinition & { label: string };

export function buildExamples(
  entries: readonly { path: string; source: string }[],
  titles: ReadonlyMap<string, string>,
): readonly LabelledExample[] {
  return entries
    .map(({ path, source }) => {
      const id = exampleIdFromGlobKey(path);
      return {
        id,
        label: exampleLabel(id, titles.get(id)),
        source,
        contentHash: contentHash(source),
      };
    })
    .sort(byDefaultFirst);
}

function byDefaultFirst(left: LabelledExample, right: LabelledExample): number {
  if (left.id === DEFAULT_EXAMPLE_ID) return -1;
  if (right.id === DEFAULT_EXAMPLE_ID) return 1;
  return left.id.localeCompare(right.id);
}
