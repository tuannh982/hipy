import manifest from "../../../simulator/testdata/fixtures.json";
import { buildExamples, defaultExampleSource } from "../lib/exampleSelection";

const exampleModules = import.meta.glob("./*.cu", {
  query: "?raw",
  import: "default",
  eager: true,
});

const titles = new Map<string, string>(
  manifest.examples.map((entry) => [entry.id, entry.title ?? ""]),
);

export const examples = buildExamples(
  Object.entries(exampleModules).map(([path, source]) => ({ path, source })),
  titles,
);

export const defaultSource = defaultExampleSource(examples);
