
export function deviceChangedSinceRun(selected: string, lastRun: string | null): boolean {
  return lastRun !== null && selected !== lastRun;
}
