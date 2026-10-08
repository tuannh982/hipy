package harness

import (
	"encoding/json"
	"testing"

	"github.com/sarchlab/mgpusim/v5/amd/ldsbank"

	"hipy/simulator/internal/otlpcmp"
	"hipy/simulator/ldswire"
)

// runComparableFixture runs a uniform fixture and returns the harness that produced
// it, WITHOUT rendering any telemetry.
//
// The harness comes back so a caller can drain the LDS bank recorder through
// run.h.LDSAnalysis() instead of reaching for ldsbank.Drain(). That matters because
// the recorder is a package-level global: draining it directly empties whatever
// every other harness in the process has recorded since.
//
// Rendering telemetry is a separate step, comparablePayload, because rendering arms
// the LDS drain, which would spend the one drain a caller has on its own behalf.
// TestLDSBankAnalysisAppendPathIsInert needs two runs with no drain between them.
//
// The normalization lives in internal/otlpcmp because
// TestLDSBankPatchIsInert applies the same one to telemetry from a different build.
func runComparableFixture(t *testing.T, id string) *Harness {
	t.Helper()

	manifest := loadManifest(t)
	_, codeObject := loadFixtureByID(t, manifest, id)
	run := runUniformFixtureRun(t, fixtureByID(t, manifest, id), codeObject,
		Config{MaxInst: 2_000_000})
	return run.h
}

// comparablePayload renders a run's metrics as a comparable string.
func comparablePayload(t *testing.T, h *Harness) string {
	t.Helper()

	metrics, err := json.Marshal(allMetrics(h.OTLPMetrics().ResourceMetrics))
	if err != nil {
		t.Fatalf("marshal metrics: %v", err)
	}
	return otlpcmp.Metrics(metrics)
}

// requireRecorderEmpty asserts that the analyzer's package-level recorder holds
// nothing when a test starts, and drains whatever it did hold. runUniformFixtureRun
// drains on cleanup, so this should always hold; asserting it turns a leak into a
// named failure instead of a puzzling pattern count.
func requireRecorderEmpty(t *testing.T) {
	t.Helper()
	pats, stats := ldsbank.Drain()
	if len(pats) != 0 {
		t.Fatalf("the LDS recorder already holds %d patterns when this test started "+
			"(%d executions and %d instance entries already dropped), so some earlier "+
			"test ran a kernel and did not drain it through its harness: the counts "+
			"below would be order-dependent", len(pats),
			stats.DroppedExecutions, stats.TruncatedInstances)
	}
}

// worstDegree is the highest conflict degree across a set of patterns.
func worstDegree(pats []LdsPattern) int {
	worst := 0
	for _, p := range pats {
		if p.Degree > worst {
			worst = p.Degree
		}
	}
	return worst
}

// TestLDSBankAnalysisRecordsConflicts asserts the feature finds the conflict the
// ldsconflict fixture was written to contain, at the two PCs the kernel's LDS
// instructions really sit at. Without it the inertness tests below would pass just
// as happily if the recorder were wired to nothing.
//
// The PC assertions are the load-bearing half: the capture path takes the PC from
// the wavefront rather than from insts.Inst.PC, which the simulator never writes, so
// a PC of 0 leaves two rows the report cannot tell apart while the opcodes still
// keep the two patterns apart.
func TestLDSBankAnalysisRecordsConflicts(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	requireRecorderEmpty(t)
	h := runComparableFixture(t, "ldsconflict")

	report := h.LDSAnalysis()
	pats := report.Patterns
	if len(pats) == 0 {
		t.Fatal("ldsconflict performs LDS accesses but the recorder saw no patterns")
	}

	conflicted := 0
	for _, p := range pats {
		if p.Degree > 1 {
			conflicted++
		}
	}
	t.Logf("%d distinct LDS patterns, %d conflicted, worst degree %d",
		len(pats), conflicted, worstDegree(pats))

	for _, p := range pats {
		for i, phase := range p.Phases {
			t.Logf("  pc=%#x %s phase %d: degree=%d lanes=%d",
				p.PC, p.Name, i, phase.Degree, len(phase.Lanes))
		}
	}
	if stats := report.Stats; stats.DroppedExecutions != 0 || stats.TruncatedInstances != 0 {
		t.Logf("drain left %d executions and %d instance entries behind",
			stats.DroppedExecutions, stats.TruncatedInstances)
	}

	// ldsconflict.cu compiles to one ds_write_b32 and one ds_read_b32, so two
	// distinct grouping keys.
	if len(pats) != 2 {
		t.Errorf("distinct LDS patterns = %d, want 2: ldsconflict.cu has exactly two "+
			"LDS instructions (ds_write_b32, ds_read_b32), so a different count means "+
			"the recorder saw something other than this kernel's DS accesses", len(pats))
	}

	seen := make(map[uint64]string, len(pats))
	for _, p := range pats {
		if p.PC == 0 {
			t.Errorf("pattern %s has PC 0: the wavefront reports no program counter, "+
				"so the capture path is reading a PC field the simulator never "+
				"writes (insts.Inst.PC is set only by the disassembler dump)", p.Name)
			continue
		}
		if other, clash := seen[p.PC]; clash {
			t.Errorf("patterns %s and %s share PC %#x: the two LDS instructions "+
				"really are at different addresses in the code object", other, p.Name, p.PC)
		}
		seen[p.PC] = p.Name
	}

	// Every active lane carries the address it read, and it lands in the bank the wire
	// says: the table derives the bank from the address, so the two must agree.
	for _, p := range pats {
		for _, lane := range p.Lanes {
			if len(lane.Addrs) == 0 {
				t.Errorf("%s: lane %d carries no address, so the per-lane table "+
					"cannot show what it read", p.Name, lane.Lane)
				continue
			}
			addr := lane.Addrs[0]
			if bank := int(addr/4) % ldswire.NumBanks; bank != lane.Bank {
				t.Errorf("%s: lane %d reports bank %d but address %#x is in bank %d "+
					"(address / 4 mod 32); the table derives the bank from the address, "+
					"so the two must agree", p.Name, lane.Lane, lane.Bank, addr, bank)
			}
		}
	}

	if conflicted == 0 {
		t.Fatal("no conflicted pattern found, but every ldsconflict LDS access " +
			"steps 8 bytes, which is a 2-way conflict by construction")
	}
	if worst := worstDegree(pats); worst != 2 {
		t.Errorf("worst conflict degree = %d, want 2: an 8-byte stride puts lane L "+
			"at bank 2L mod 32, so each even bank takes exactly two distinct "+
			"addresses per 32-lane phase", worst)
	}
}

// TestLDSConflictFixtureIsIndexedInBounds guards the coupling between
// ldsconflict.cu and its manifest recipe. The kernel indexes the shared tile and
// the input buffers with a single unbounded i == blockIdx.x*blockDim.x +
// threadIdx.x, so they are in range only while the launch fills exactly one wave of
// 64.
//
// The fix would not be a bounds loop in the kernel: a bounded loop compiles into
// s_cbranch_execz, which MGPUSim answers by splitting the wavefront and narrowing
// the exec mask, destroying the full 32-lane phases whose two-way conflict is the
// point of the fixture. The invariant is asserted here instead.
func TestLDSConflictFixtureIsIndexedInBounds(t *testing.T) {
	manifest := loadManifest(t)
	var recipe *uniformLaunchSpec
	for _, candidate := range manifest.Fixtures {
		if candidate.ID == "ldsconflict" {
			recipe = candidate.UniformLaunch
		}
	}
	if recipe == nil {
		t.Fatal("manifest has no ldsconflict fixture carrying a uniformLaunch recipe")
	}

	if want := uint32(64); recipe.Block[0] != want {
		t.Errorf("block[0] = %d, want %d: ldsconflict.cu indexes a 128-float tile and "+
			"64-element buffers with an unbounded i, so only a 64-wide block is in bounds",
			recipe.Block[0], want)
	}
	if recipe.Elements != 64 {
		t.Errorf("elements = %d, want 64: a[i] and b[i] are read without a bounds check",
			recipe.Elements)
	}
	// grid counts total work items in this harness (harness.go:328), so a grid of
	// 64 over a 64-wide block is one work group; a grid above 64 would run a
	// second group and push i past the end of every buffer.
	if uint32(recipe.Elements) != recipe.Grid[0] {
		t.Errorf("grid[0] = %d, want elements (%d): grid counts work items here, so "+
			"grid[0] > elements runs a second work group and indexes past the buffers",
			recipe.Grid[0], recipe.Elements)
	}
	if recipe.Block[1] != 1 || recipe.Block[2] != 1 || recipe.Grid[1] != 1 || recipe.Grid[2] != 1 {
		t.Errorf("ldsconflict is a 1-D launch, got grid %v block %v",
			recipe.Grid, recipe.Block)
	}
}

// TestLDSBankAnalysisIsInert asserts that two runs of the fixture report identical
// telemetry. The LDS unit charges every access a flat 14 cycles and reads nothing
// from the analysis, so a conflict changes no timing at all. The whole rendered
// telemetry is compared, not a hand-picked subset. Draining between the runs limits
// this; see TestLDSBankAnalysisAppendPathIsInert.
func TestLDSBankAnalysisIsInert(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	requireRecorderEmpty(t)
	first := comparablePayload(t, runComparableFixture(t, "ldsconflict"))
	second := comparablePayload(t, runComparableFixture(t, "ldsconflict"))

	if first != second {
		t.Fatalf("telemetry changed between two runs of the same workload; "+
			"first difference at offset %d\nfirst  %s\nsecond %s",
			firstDifference(first, second), excerptAround(first, second), excerptAround(second, first))
	}
}

// TestLDSBankAnalysisAppendPathIsInert does not drain between its two runs, so the
// second reaches Recorder.Record with the keys already present and takes the other
// branch: the Count++ and Instances append. The Count assertion below establishes
// that, so the equality that follows is evidence rather than a tautology. Both
// payloads render against that one shared drain, which is the view the browser gets.
func TestLDSBankAnalysisAppendPathIsInert(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	requireRecorderEmpty(t)
	firstHarness := runComparableFixture(t, "ldsconflict")
	secondHarness := runComparableFixture(t, "ldsconflict")

	pats := secondHarness.LDSAnalysis().Patterns
	if len(pats) == 0 {
		t.Fatal("no patterns recorded, so there was no append path to exercise")
	}
	for _, p := range pats {
		// One execution per pattern from the opening run, one from the run that
		// found the key already present.
		if p.Count != 2 {
			t.Errorf("pattern %s at pc %#x has count %d, want 2: the second run did "+
				"not fold into the pattern the first run opened, so the append path "+
				"was never exercised", p.Name, p.PC, p.Count)
		}
	}

	// The one drain the two runs share indexes both of them: two instance ids per run,
	// at different tracing task ids, since the task id counter does not restart with
	// the harness.
	index := secondHarness.ldsIndex()
	if len(index) != 4 {
		t.Errorf("shared index holds %d instructions, want 4 (two LDS "+
			"instructions from each of the two runs)", len(index))
	}

	if first, second := comparablePayload(t, firstHarness), comparablePayload(t, secondHarness); first != second {
		t.Fatalf("telemetry changed once a bank analysis was folded into an open "+
			"pattern; first difference at offset %d\nfirst  %s\nsecond %s",
			firstDifference(first, second), excerptAround(first, second), excerptAround(second, first))
	}
}

// firstDifference reports the byte offset at which two comparable payloads stop
// matching, or the length of the shorter one when they agree that far.
func firstDifference(a, b string) int {
	limit := min(len(a), len(b))
	for i := range limit {
		if a[i] != b[i] {
			return i
		}
	}
	return limit
}

// excerptAround renders the neighbourhood of the first difference between two
// comparable payloads. The payloads are 150 kB of JSON, so printing either in
// full would bury the one field that moved.
func excerptAround(a, other string) string {
	at := firstDifference(a, other)
	from := max(at-120, 0)
	to := min(at+120, len(a))
	return a[from:to]
}
