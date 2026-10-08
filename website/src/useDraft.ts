import { useCallback, useState } from "react";
import { readDraft, writeDraft } from "./lib/drafts";

export type DraftOptions = {
    storageKey?: string;
    fallback: string;
};

export function useDraft({ storageKey, fallback }: DraftOptions): [string, (next: string) => void] {
  const [source, setSourceState] = useState(() => readDraft(storageKey) ?? fallback);

  const setSource = useCallback(
    (next: string) => {
      setSourceState(next);
      writeDraft(storageKey, next);
    },
    [storageKey],
  );

  return [source, setSource];
}
