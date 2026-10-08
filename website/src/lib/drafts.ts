export const PLAYGROUND_DRAFT_KEY = "hipy:hip-source:v1";

export function lessonDraftKey(lessonId: string): string {
  return `hipy:lesson-draft:v1:${lessonId}`;
}

// Undefined rather than "" is how a caller says "this context does not persist".
// An empty key is a real entry name, so "" would read and write one.
export function readDraft(key: string | undefined): string | null {
  if (key === undefined) return null;
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeDraft(key: string | undefined, source: string): void {
  if (key === undefined) return;
  try {
    globalThis.localStorage?.setItem(key, source);
  } catch {
    // Quota or a disabled store. The draft is lost; the edit is not.
  }
}
