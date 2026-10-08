import { readDraft, writeDraft } from "../lib/drafts";

export const COMPLETION_KEY = "hipy:learn-completion:v1";

export type Completion = Record<string, string[]>;

export function emptyCompletion(): Completion {
  return {};
}

export function isLessonComplete(completion: Completion, trackId: string, lessonId: string): boolean {
  return (completion[trackId] ?? []).includes(lessonId);
}

export function markLessonComplete(completion: Completion, trackId: string, lessonId: string): Completion {
  const existing = completion[trackId] ?? [];
  if (existing.includes(lessonId)) return completion;
  return { ...completion, [trackId]: [...existing, lessonId] };
}

export function clearLessonComplete(completion: Completion, trackId: string, lessonId: string): Completion {
  const existing = completion[trackId];
  if (existing === undefined || !existing.includes(lessonId)) return completion;
  const next = existing.filter((id) => id !== lessonId);
                const entries = Object.entries(completion).filter(([id]) => id !== trackId);
        if (next.length > 0) entries.push([trackId, next]);
  return Object.fromEntries(entries);
}

function sanitizeStored(value: unknown): Completion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyCompletion();
  const entries: [string, string[]][] = [];
  for (const [trackId, ids] of Object.entries(value)) {
                if (!Array.isArray(ids)) continue;
                const kept = ids.filter((id): id is string => typeof id === "string");
    if (kept.length === 0) continue;
    entries.push([trackId, kept]);
  }
          return Object.fromEntries(entries);
}

export function readCompletion(): Completion {
  const raw = readDraft(COMPLETION_KEY);
  if (raw === null) return emptyCompletion();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated by a half-finished write, or hand-edited. Nothing to salvage.
    return emptyCompletion();
  }
  return sanitizeStored(parsed);
}

export function writeCompletion(completion: Completion): void {
  writeDraft(COMPLETION_KEY, JSON.stringify(completion));
}
