import { MarkdownPane } from "../markdown/MarkdownPane";
import { referencesBody } from "../pages/references";

export function ReferencesPage() {
  return (
    <div className="page-shell">
      <MarkdownPane source={referencesBody} />
    </div>
  );
}
