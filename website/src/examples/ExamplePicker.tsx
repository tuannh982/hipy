import { selectedExampleId } from "../lib/exampleSelection";
import { examples } from "./registry";

export function ExamplePicker({
  source,
  onSelect,
}: {
  source: string;
  onSelect(id: string): void;
}) {
  const selected = selectedExampleId(source, examples);

  return (
    <label className="example-select">
      <span>Example</span>
      <select value={selected ?? ""} onChange={(event) => onSelect(event.target.value)}>
        {selected === null && <option value="" disabled>Custom source</option>}
        {examples.map((example) => (
          <option value={example.id} key={example.id}>{example.label}</option>
        ))}
      </select>
    </label>
  );
}
