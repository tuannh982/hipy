import { toolchainBoundaries } from "../lib/toolchainBoundaries";

// What the toolchain will refuse to build, read from the table the negative compile
// suite asserts (toolchain/tests/scripts/compile-failure-test.mjs compiles each
// fixture and fails if the message is not the one emitted).
//
// The table is the one place a rejection is written down outside the code that
// emits it: the negative suite asserts each compile-phase row by compiling its
// fixture, compile-test.mjs reads the atomics row for its separate clang
// invocation, and compilePipeline.ts reads the fp64 row for the browser check a
// learner hits. The launch row can only be grepped for in wasmexec/exports.go,
// which is weaker than "asserted" suggests. The enforcement files themselves do
// not read the table: the strings are checked against them, so a mismatch is
// corrected in the row.
//
// The table is reached through lib/toolchainBoundaries.ts rather than imported
// here, because the editor footer renders the compile-time rows as a one-line
// summary and both renderings have to come from one place -- otherwise the footer
// and the About tab are two lists of the same capabilities, free to disagree.

// phase is "compile" or "launch", and the row reads the same either way: both are
// hard failures, and only the phase differs. An unknown value falls to the launch
// wording rather than throwing, so a typo in a table read from disk costs one line
// of a row rather than the tab.
const phaseNote = (phase: string) => (phase === "compile" ? "Fails to compile" : "Fails at launch");

export function ToolchainBoundaries() {
  return (
    <dl className="config-grid">
      {toolchainBoundaries.map((boundary) => (
        <div key={boundary.id}>
          <dt>
            {boundary.label}
            <abbr title={boundary.detail}>?</abbr>
          </dt>
          <dd>
            Rejected
            {/* The diagnostic is rendered, not left in the tooltip. The rows this
                component replaces quoted it in an <abbr title>, which is the
                right string in the wrong place: it is there only on hover, so a
                learner on a touch screen cannot reach it, it cannot be selected
                and pasted into a search, and a screenshot of the tab does not
                contain it. The one job this list has is letting someone match
                the error on their screen to a row here, and that fails if the
                only copy is behind a hover. detail stays on the marker because
                it is prose about why, and prose belongs in the tooltip the rest
                of the About grid uses. */}
            <code className="boundary-message">{boundary.message}</code>
            <small>{phaseNote(boundary.phase)}</small>
          </dd>
        </div>
      ))}
    </dl>
  );
}
