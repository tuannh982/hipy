// Whether the select names a device other than the one the results on screen were
// produced for. `lastRun` is null before anything has run, and that is not a
// divergence: with no telemetry on screen there is nothing to disagree with, and a
// marker on a first visit would claim the About tab was describing stale results.
//

// This is the launch-geometry divergence badge's shape, on the control that
// replaced it. The About heading, ISA row, paragraph, disclaimer, editor footer
// and LDS caveat are all derived from the SELECTED device, so they move when the
// select does; the Dashboard and LDS figures still show whatever device was last
// run. Unmarked, the tab states the new device's numbers under the old device's
// measurements. With one device it is unobservable, and it is not built for
// that: it is here so the second entry cannot ship without it.
export function deviceChangedSinceRun(selected: string, lastRun: string | null): boolean {
  return lastRun !== null && selected !== lastRun;
}
