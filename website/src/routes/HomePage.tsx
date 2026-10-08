import { MarkdownPane } from "../markdown/MarkdownPane";
import { homeBody } from "../pages/home";

export function HomePage() {
  return (
    <div className="page-shell">
      <MarkdownPane source={homeBody} />
    </div>
  );
}
