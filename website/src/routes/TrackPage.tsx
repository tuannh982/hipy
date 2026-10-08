import { Link, Navigate, useParams } from "react-router-dom";
import { isLessonComplete, readCompletion } from "../lessons/completion";
import { completedCount, findTrack, taskCount } from "../lessons/lookup";
import { tracks } from "../lessons/tracks";

export function TrackPage() {
  const { trackId } = useParams();
  const track = trackId === undefined ? tracks[0] : findTrack(tracks, trackId);

  if (track === undefined || track === null) return <Navigate to="/learn" replace />;

  const completion = readCompletion();
  const completed = completion[track.id] ?? [];

  return (
    <div className="learn-page">
      <div className="learn-header">
        <div className="learn-identity">
          <span className="eyebrow learn-track-number">Track {track.number}</span>
          <h1 className="learn-title">{track.title}</h1>
        </div>
        <div className="learn-summary">
          <p className="learn-tagline">{track.tagline}</p>
          <div className="learn-progress">
            {completedCount(track, completed)} of {taskCount(track)} tasks complete
          </div>
        </div>
      </div>
      <div className="module-grid">
        {track.modules.map((module) => {
          const lessons = module.lessons;
          const done = lessons.filter((lesson) => isLessonComplete(completion, track.id, lesson.id)).length;
          const status =
            lessons.length === 0
              ? "Not written yet"
              : done === lessons.length
                ? "Completed"
                : `${done} / ${lessons.length}`;
          const nextUp =
            lessons.find((lesson) => !isLessonComplete(completion, track.id, lesson.id)) ?? lessons[0];
          const moduleNumber = `${track.number}.${module.number}`;
          const body = (
            <>
              <div className="module-art" aria-hidden="true">
                <span className="module-art-blocks" />
              </div>
              <div className="module-body">
                <span className="eyebrow">
                  Module {moduleNumber} · {lessons.length} {lessons.length === 1 ? "task" : "tasks"}
                </span>
                <h2 className="module-title">{module.title}</h2>
                <p className="module-blurb">{module.blurb}</p>
                <div className="module-footer">
                  <div className="pips" aria-hidden="true">
                    {lessons.map((lesson) =>
                      isLessonComplete(completion, track.id, lesson.id) ? (
                        <span className="pip pip-done" key={lesson.id} title={lesson.title} />
                      ) : (
                        <span className="pip" key={lesson.id} title={lesson.title} />
                      ),
                    )}
                  </div>
                  <span className="pip-status">{status}</span>
                </div>
              </div>
            </>
          );
          if (lessons.length === 0) {
            return (
              <div className="module-card" key={module.id}>
                {body}
              </div>
            );
          }
          return (
            <Link
              className="module-card"
              to={`/learn/${track.id}/${nextUp.id}`}
              key={module.id}
              aria-label={`${module.title}, ${lessons.length} ${lessons.length === 1 ? "task" : "tasks"}, ${status}`}
            >
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
