
import type { Lesson, Module, Track } from "./types";

export type LessonRef = {
  track: Track;
  module: Module;
  lesson: Lesson;
};

export function flattenLessons(track: Track): Lesson[] {
  return track.modules.flatMap((module) => module.lessons);
}

export function findTrack(tracks: readonly Track[], trackId: string): Track | null {
  return tracks.find((track) => track.id === trackId) ?? null;
}

export function findLesson(
  tracks: readonly Track[],
  trackId: string,
  lessonId: string,
): LessonRef | null {
  const track = findTrack(tracks, trackId);
  if (track === null) return null;
  for (const module of track.modules) {
    const lesson = module.lessons.find((item) => item.id === lessonId);
    if (lesson !== undefined) return { track, module, lesson };
  }
  return null;
}

export function moduleOfLesson(track: Track, lessonId: string): Module | null {
  return track.modules.find((module) => module.lessons.some((lesson) => lesson.id === lessonId)) ?? null;
}

export function lessonNeighbours(
  track: Track,
  lessonId: string,
): { previous: Lesson | null; next: Lesson | null } {
  const ordered = flattenLessons(track);
  const at = ordered.findIndex((lesson) => lesson.id === lessonId);
  if (at === -1) return { previous: null, next: null };
  return {
    previous: at > 0 ? ordered[at - 1] : null,
    next: at < ordered.length - 1 ? ordered[at + 1] : null,
  };
}

export function lessonCount(module: Module): number {
  return module.lessons.length;
}

export function taskCount(track: Track): number {
  return track.modules.reduce((total, module) => total + lessonCount(module), 0);
}

export function completedCount(track: Track, completed: readonly string[]): number {
  const present = new Set(flattenLessons(track).map((lesson) => lesson.id));
  return [...new Set(completed)].filter((id) => present.has(id)).length;
}

export function assertUniqueLessonIds(tracks: readonly Track[]): void {
  const seen = new Set<string>();
  for (const track of tracks) {
    for (const module of track.modules) {
      for (const lesson of module.lessons) {
        const key = `${track.id}/${lesson.id}`;
        if (seen.has(key)) {
          throw new Error(
            `Duplicate Lesson.id "${lesson.id}" in track "${track.id}" (module "${module.id}"). ` +
              `Lesson ids are unique per track: completion is keyed by trackId + lessonId, ` +
              `never by moduleId + lessonId.`,
          );
        }
        seen.add(key);
      }
    }
  }
}
