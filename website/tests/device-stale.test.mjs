// The staleness badge beside the device select.
//
// One predicate decides whether the badge shows, and it is the only thing standing
// between the reader and a claim that is not true. The badge reads "Changed since
// last run", so it is asserting that results are on screen from a different
// device than the one selected. Every way it can be wrong is a lie on screen:
//
//   - showing with nothing on screen (the reader has not run anything, so there is
//     no result to have gone stale), and
//   - hiding while a real divergence is on screen, which is the failure the badge
//     exists to prevent.
//
// The sentinel for "nothing has run" is null, not "". That distinction is the
// whole test: an empty string is a device NAME, and no device has that name, so it
// compares unequal to every selection and the predicate answers "yes, they
// diverge" when nothing has run at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const { deviceChangedSinceRun } = await tsImport(
  path.join(repoRoot, "website", "src", "lib", "deviceConfig.ts"),
  import.meta.url,
);

test("no run means no divergence, so the badge stays hidden", () => {
  // Before anything has run there is nothing on screen that a new selection could
  // contradict. The badge here would tell a first-time visitor their results are
  // stale when they have none.
  assert.equal(deviceChangedSinceRun("gcn3generic", null), false);
  assert.equal(deviceChangedSinceRun("cdna3generic", null), false);
});

test("an empty lastRunDevice is a divergence, because it names no device", () => {
  // "" is not the sentinel -- it is a string no catalog entry has a name for, so it
  // compares unequal to whatever is selected and the badge appears with nothing
  // behind it. The fix is a one-character difference that reads as interchangeable.
  assert.equal(deviceChangedSinceRun("gcn3generic", ""), true);
});

test("selecting a device after a run on another one shows the badge", () => {
  // The case the badge is FOR: the Dashboard still shows the old device's traffic
  // under a select naming the new one, and only the badge says so.
  assert.equal(deviceChangedSinceRun("cdna3generic", "gcn3generic"), true);
});

test("selecting the device the run used keeps the badge hidden", () => {
  assert.equal(deviceChangedSinceRun("gcn3generic", "gcn3generic"), false);
});

test("the two reset paths write null, not an empty string", async () => {
  // Asserted against the source rather than the behaviour: both places that clear
  // "which device produced the numbers on screen" must write the sentinel, and both
  // sit in App.tsx where no test can reach them at runtime.
  const app = await readFile(path.join(repoRoot, "website", "src", "App.tsx"), "utf8");
  assert.ok(
    !app.includes('setLastRunDevice("")'),
    'App.tsx writes setLastRunDevice(""); the sentinel is null, and "" badges the select as stale with nothing on screen',
  );
  // And the badge is rendered on the predicate alone -- an ungated render beside
  // the select is what made the stray value visible.
  assert.ok(
    app.includes("deviceChangedSinceRun(device, lastRunDevice)"),
    "the badge should be gated on deviceChangedSinceRun",
  );
});