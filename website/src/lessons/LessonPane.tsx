import type { Lesson } from "./types";
import { MarkdownPane } from "../markdown/MarkdownPane";

export function LessonPane({ lesson, taskCount }: { lesson: Lesson; taskCount: number }) {
  return (
    <div className="lesson-pane">
      <span className="eyebrow">Task {lesson.number} of {taskCount}</span>
      <h2 className="lesson-title">{lesson.title}</h2>
      <MarkdownPane source={lesson.body} assets={lesson.assets} />
            <div className="goal-callout">
        <span className="eyebrow">Goal</span>
        <p>{lesson.goal}</p>
      </div>
    </div>
  );
}
