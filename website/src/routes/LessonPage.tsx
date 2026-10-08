import { useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  PaneDivider,
  storedPaneSize,
} from "../components/PaneDivider";
import {
  clearLessonComplete,
  isLessonComplete,
  markLessonComplete,
  readCompletion,
  writeCompletion,
  type Completion,
} from "../lessons/completion";
import { LessonPane } from "../lessons/LessonPane";
import { findLesson, lessonCount, lessonNeighbours } from "../lessons/lookup";
import { tracks } from "../lessons/tracks";
import type { Lesson, Module, Track } from "../lessons/types";
import { EditorPanel } from "../gpu/EditorPanel";
import { GpuTabs } from "../gpu/GpuTabs";
import { GpuToolbar } from "../gpu/GpuToolbar";
import { useGpuRun } from "../gpu/useGpuRun";
import { lessonDraftKey } from "../lib/drafts";
import { useDraft } from "../useDraft";

const lessonWidthKey = "hipy:lesson-width:v1";
const lessonEditorHeightKey = "hipy:lesson-editor-height:v1";

export function LessonPage() {
  const { trackId = "", lessonId = "" } = useParams();
  const found = findLesson(tracks, trackId, lessonId);

  // A stale bookmark, or a lesson id belonging to another track. /learn lists what
  // exists, which is a better landing than a blank pane.
  if (found === null) return <Navigate to="/learn" replace />;

                                            return (
    <LessonView
      key={`${found.track.id}/${found.lesson.id}`}
      track={found.track}
      module={found.module}
      lesson={found.lesson}
    />
  );
}

function LessonView({
  track,
  module,
  lesson,
}: {
  track: Track;
  module: Module;
  lesson: Lesson;
}) {
        const [source, setSource] = useDraft({
    storageKey: lessonDraftKey(lesson.id),
    fallback: lesson.starter,
  });
  const gpu = useGpuRun({ source });

        const bodyRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [lessonWidth, setLessonWidth] = useState<number | null>(() => storedPaneSize(lessonWidthKey));
  const [editorHeight, setEditorHeight] = useState<number | null>(() =>
    storedPaneSize(lessonEditorHeightKey),
  );

          const [completion, setCompletion] = useState<Completion>(() => readCompletion());
  const done = isLessonComplete(completion, track.id, lesson.id);

  // Both transitions write through the record the track page reads, so a pip fills
  // the moment the reader claims the lesson rather than on their next visit.
  const toggleDone = (): void => {
    const next = done
      ? clearLessonComplete(completion, track.id, lesson.id)
      : markLessonComplete(completion, track.id, lesson.id);
    setCompletion(next);
    writeCompletion(next);
  };

  const { previous, next } = lessonNeighbours(track, lesson.id);

          const changed = source !== lesson.starter;

  return (
    <div className="lesson-shell">
      <div className="lesson-toolbar">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to="/learn">Learn</Link>
          <span>/</span>
          <span className="breadcrumb-track">{track.title}</span>
          <span>/</span>
          <span className="breadcrumb-current">{lesson.title}</span>
        </nav>
        <div className="lesson-actions">
          <button className="button button-primary" onClick={toggleDone}>
            {done ? "Mark incomplete" : "Mark complete"}
          </button>
          {/* Reset restores the starter AND drops the completion mark. The two are
              the same claim, and a pip filled against code that is no longer on
              screen would be the one thing on the page that is not true.

              It goes blue only once there is something to undo: against an
              untouched starter the button has no work to do, and a primary fill
              there would invite a click that changes nothing. */}
          <button
            className={changed ? "button button-primary" : "button"}
            onClick={() => {
              setSource(lesson.starter);
                                                                                    gpu.noteSourceEdited();
              if (done) toggleDone();
            }}
          >
            Reset code
          </button>
          <Link className="button" to="/learn">Exit module</Link>
          {previous !== null && (
            <Link className="button" to={`/learn/${track.id}/${previous.id}`}>Prev task</Link>
          )}
          {next !== null ? (
            <Link className="button button-primary" to={`/learn/${track.id}/${next.id}`}>Next task</Link>
          ) : (
            // Disabled rather than hidden: the reader needs to see that the track
            // ends here, not find the button missing and wonder why.
            <button className="button button-primary" disabled title="Last task in this track">
              Next task
            </button>
          )}
        </div>
      </div>

      <div
        className="lesson-body"
        ref={bodyRef}
        style={
          lessonWidth === null ? undefined : { "--lesson-width": `${lessonWidth}px` } as React.CSSProperties
        }
      >
        <LessonPane lesson={lesson} taskCount={lessonCount(module)} />
        <PaneDivider
          container={bodyRef}
          value={lessonWidth}
          onChange={setLessonWidth}
          storageKey={lessonWidthKey}
          label="Resize the lesson pane"
        />
        <div
          className="lesson-workspace"
          ref={workspaceRef}
          style={
            editorHeight === null
              ? undefined
              : { "--lesson-editor-height": `${editorHeight}px` } as React.CSSProperties
          }
        >
          {/* One grid item holding the toolbar, the editor and its arch footer.
              EditorPanel returns a fragment, so without this wrapper its host and
              footer would each land in their own row of the workspace grid. */}
          <div className="lesson-editor">
            <GpuToolbar gpu={gpu} />
            {/* TYPED edits need nothing here: EditorPanel makes noteSourceEdited()
                inside its own change handler, so a page that renders an editor
                cannot forget it. A PROGRAMMATIC replacement is a different path --
                it never reaches EditorPanel -- which is why the Reset handler
                above calls it itself. */}
            <EditorPanel source={source} gpu={gpu} onSourceChange={setSource} />
          </div>
          <PaneDivider
            container={workspaceRef}
            value={editorHeight}
            onChange={setEditorHeight}
            orientation="horizontal"
            storageKey={lessonEditorHeightKey}
            label="Resize the editor height"
          />
          <GpuTabs gpu={gpu} />
        </div>
      </div>
    </div>
  );
}
