package harness

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/sarchlab/mgpusim/v5/amd/ldsbank"

	"hipy/simulator/internal/ldsanalysis"
)

// withLDS links the real analyzer into a test harness. Package harness takes its
// drain from Config rather than importing one so it still compiles against an
// unpatched MGPUSim, which makes every construction site responsible for linking it.
// The one place that deliberately does not is TestHarnessWithoutAnAnalyzerReportsNothing.
func withLDS(cfg Config) Config {
	cfg.LDSDrain = ldsanalysis.Drain
	return cfg
}

// loadLDSConflictFixture runs the ldsconflict fixture and returns the harness.
// That kernel's two LDS accesses are a write at pc 0x4074 and a read at pc 0x4084,
// each a 2-way conflict by construction (an 8-byte stride, so 16 even banks each
// take two distinct addresses within a 32-lane phase).
func loadLDSConflictFixture(t *testing.T) *Harness {
	t.Helper()
	manifest := loadManifest(t)
	_, codeObject := loadFixtureByID(t, manifest, "ldsconflict")
	run := runUniformFixtureRun(t, fixtureByID(t, manifest, "ldsconflict"), codeObject,
		Config{MaxInst: 2_000_000})
	return run.h
}

// readWrite names an LdsPattern's polarity for a failure message. A bare true or
// false in a diff about a read/write disagreement does not say which side is wrong.
func readWrite(isRead bool) string {
	if isRead {
		return "read"
	}
	return "write"
}

func fixtureByID(t *testing.T, manifest fixtureManifest, id string) fixtureSpec {
	t.Helper()
	for _, f := range uniformFixtures(manifest) {
		if f.ID == id {
			return f
		}
	}
	t.Fatalf("fixture %q has no uniformLaunch recipe", id)
	return fixtureSpec{}
}

func TestLDSAnalysisFindsBothAccesses(t *testing.T) {
	h := loadLDSConflictFixture(t)

	report := h.LDSAnalysis()

	if len(report.Patterns) != 2 {
		t.Fatalf("patterns = %d, want 2 (one write, one read)", len(report.Patterns))
	}
	conflicted := 0
	reads := 0
	writes := 0
	for _, p := range report.Patterns {
		if p.Degree != 2 {
			t.Errorf("pattern %s: degree = %d, want 2", p.Name, p.Degree)
		}
		if p.Degree > 1 {
			conflicted++
		}
		if p.IsRead {
			reads++
		} else {
			writes++
		}
	}
	if conflicted != 2 {
		t.Errorf("conflicted patterns = %d, want 2", conflicted)
	}
	if reads != 1 || writes != 1 {
		t.Errorf("read/write split = %d/%d, want 1/1", reads, writes)
	}
}

func TestLDSAnalysisPatternCarriesTheDrawableDetail(t *testing.T) {
	h := loadLDSConflictFixture(t)
	report := h.LDSAnalysis()

	for _, p := range report.Patterns {
		if p.Stride != 8 {
			t.Errorf("%s: stride = %d, want 8", p.Name, p.Stride)
		}
		if len(p.Phases) != 2 {
			t.Fatalf("%s: phases = %d, want 2 (32 lanes each for b32)", p.Name, len(p.Phases))
		}
		for i, ph := range p.Phases {
			if len(ph.Lanes) != 32 {
				t.Errorf("%s phase %d: lanes = %d, want 32", p.Name, i, len(ph.Lanes))
			}
			if ph.Degree != 2 {
				t.Errorf("%s phase %d: degree = %d, want 2", p.Name, i, ph.Degree)
			}
		}
		if len(p.Lanes) != 64 {
			t.Errorf("%s: lane rows = %d, want 64", p.Name, len(p.Lanes))
		}
	}
}

// A write race and a broadcast are the same thing to this analyzer: both are two
// lanes at one address. The UI must not claim otherwise.
func TestLDSAnalysisMarksApproximateModels(t *testing.T) {
	h := loadLDSConflictFixture(t)
	report := h.LDSAnalysis()

	// b32 accesses are fully sourced, so neither flag may be set on them.
	for _, p := range report.Patterns {
		if p.PhaseModelApproximate {
			t.Errorf("%s: PhaseModelApproximate set on a b32 access", p.Name)
		}
		if p.AddressGranularityApproximate {
			t.Errorf("%s: AddressGranularityApproximate set on a b32 access", p.Name)
		}
	}
}

func TestLDSIndexIsIdempotent(t *testing.T) {
	h := loadLDSConflictFixture(t)

	first := h.ldsIndex()
	second := h.ldsIndex()

	if len(first) == 0 {
		t.Fatal("ldsIndex is empty; the drain produced no instruction tasks")
	}
	if len(first) != len(second) {
		t.Fatalf("ldsIndex changed size across calls: %d then %d", len(first), len(second))
	}
	if !reflect.DeepEqual(first, second) {
		t.Error("ldsIndex returned different entries across calls; the drain is " +
			"supposed to happen once and be cached, not redone")
	}

	// The report's instance lists and the index are the same set of task ids, or one
	// of them is wrong. A disagreement means they came from different drains, which
	// is what a caller joining a span against the bank map would silently act on.
	report := h.LDSAnalysis()
	named := make(map[uint64]bool)
	for _, p := range report.Patterns {
		for _, id := range p.Instances {
			named[id] = true
		}
	}
	if len(named) != len(first) {
		t.Fatalf("index holds %d task ids, the report names %d distinct ones; the "+
			"two views came from different drains", len(first), len(named))
	}
	for id := range first {
		if !named[id] {
			t.Errorf("index holds task %d, which no pattern's instance list names", id)
		}
	}
	for id := range named {
		if _, ok := first[id]; !ok {
			t.Errorf("report names task %d, which the index does not hold", id)
		}
	}
}

// What cmd/lds-telemetry builds against a bare checkout of the pinned commit, and
// what a build looks like if a host forgot Config.LDSDrain. The empty report must
// still satisfy the wire contract: an empty ARRAY, because the website iterates
// patterns and a null would be a second shape for the same field.
func TestHarnessWithoutAnAnalyzerReportsNothing(t *testing.T) {
	h := New(Config{})

	report := h.LDSAnalysis()
	if len(report.Patterns) != 0 {
		t.Errorf("a harness with no analyzer reports %d patterns, want none: "+
			"nothing was recorded, so there is nothing to report", len(report.Patterns))
	}
	if report.Patterns == nil {
		t.Error("Patterns is nil, so the body marshals as null and the UI has to " +
			"special-case a second shape for the same field")
	}
	if got, want := string(mustMarshal(t, report)),
		`{"patterns":[],"stats":{"patterns":0,"droppedExecutions":0,"truncatedInstances":0}}`; got != want {
		t.Errorf("empty report JSON = %s, want %s", got, want)
	}
	if len(h.ldsIndex()) != 0 {
		t.Errorf("a harness with no analyzer indexed %d instructions", len(h.ldsIndex()))
	}
}

// The other way a null reaches the same field: a drain that built the report with a
// struct literal and forgot the slice. drainLdsbank normalises it.
func TestADrainThatReturnsNoPatternsStillMarshalsAsAnArray(t *testing.T) {
	h := New(Config{LDSDrain: func() (LdsAnalysisReport, map[uint64]LdsInst) {
		return LdsAnalysisReport{}, map[uint64]LdsInst{}
	}})

	if got := string(mustMarshal(t, h.LDSAnalysis())); !strings.HasPrefix(got, `{"patterns":[],`) {
		t.Errorf("a drain that returned no patterns marshals as %s, want an empty array", got)
	}
}

func TestLDSAnalysisIsValidJSON(t *testing.T) {
	h := loadLDSConflictFixture(t)
	report := h.LDSAnalysis()

	if len(report.Patterns) == 0 {
		t.Fatal("ldsconflict recorded no patterns, so there is no wire to check")
	}

	envelope := marshalReportEnvelope(t, report)
	if len(envelope) != 2 || envelope["patterns"] == nil || envelope["stats"] == nil {
		t.Fatalf("report envelope has %d members %v, want exactly patterns and stats",
			len(envelope), rawMessageKeys(envelope))
	}

	var back LdsAnalysisReport
	if err := json.Unmarshal(mustMarshal(t, report), &back); err != nil {
		t.Fatalf("a client cannot read this report back: %v", err)
	}
	if !reflect.DeepEqual(back, report) {
		t.Error("the report does not survive a marshal/unmarshal round trip; the " +
			"bytes a client receives do not describe the drained report")
	}
	if len(back.Patterns) != len(report.Patterns) {
		t.Fatalf("round trip returned %d patterns, the drain produced %d",
			len(back.Patterns), len(report.Patterns))
	}

	// The stats block is nested under the envelope, so it is the one part of the
	// report that has to be reached through a raw message.
	stats := unmarshalLdsStats(t, envelope["stats"])
	if stats != report.Stats {
		t.Errorf("stats on the wire = %+v, want the drain's %+v", stats, report.Stats)
	}
	if stats.Patterns != uint64(len(report.Patterns)) {
		t.Errorf("stats.patterns = %d but the report holds %d patterns", stats.Patterns,
			len(report.Patterns))
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func TestLDSAnalysisIsEmptyWithoutLDS(t *testing.T) {
	manifest := loadManifest(t)
	_, codeObject := loadFixtureByID(t, manifest, "vectoradd")
	run := runUniformFixtureRun(t, fixtureByID(t, manifest, "vectoradd"), codeObject,
		Config{MaxInst: 2_000_000})

	report := run.h.LDSAnalysis()
	if len(report.Patterns) != 0 {
		t.Fatalf("vectoradd performs no LDS; got %d patterns", len(report.Patterns))
	}
	if len(run.h.ldsIndex()) != 0 {
		t.Fatal("vectorad has no LDS instructions, so the index must be empty")
	}
}

// Drain is destructive in the analyzer, so the harness must cache what it drained
// rather than letting a second caller see an empty recorder.
func TestLDSAnalysisSurvivesRepeatedCalls(t *testing.T) {
	h := loadLDSConflictFixture(t)

	first := h.LDSAnalysis()
	second := h.LDSAnalysis()

	if len(first.Patterns) != len(second.Patterns) {
		t.Fatalf("second call returned %d patterns, first returned %d; the drain is not cached",
			len(second.Patterns), len(first.Patterns))
	}
}

func TestLDSAnalysisRestatsTheRecorder(t *testing.T) {
	h := loadLDSConflictFixture(t)
	h.LDSAnalysis()
	if _, stats := ldsbank.Drain(); stats.Patterns != 0 {
		t.Fatalf("the recorder still holds %d patterns after the harness drained it", stats.Patterns)
	}
}

// ldsConflictAnalysis is a synthetic ds_write_b32 access with the same geometry as
// ldsconflict.cu's: every lane active, lane L at byte 8L, so bank = (2L) mod 32 and
// each 32-lane phase is 2-way conflicted. Driving the report from a known Access is
// what the truncation and honesty-marker specs need, since ldsconflict is entirely
// b32 and its approximation flags are always false.
func ldsConflictAnalysis(t *testing.T) ldsbank.Analysis {
	t.Helper()
	const opcodeWriteB32 = 13
	access := ldsbank.Access{
		PC:     0x1234,
		Opcode: opcodeWriteB32,
		Exec:   ^uint64(0),
	}
	for lane := 0; lane < ldsbank.WavefrontLanes; lane++ {
		access.Addr[lane][0] = uint32(8 * lane)
	}
	an, ok := ldsbank.Analyze(access)
	if !ok {
		t.Fatalf("opcode %d is not a DS access this analyzer models", opcodeWriteB32)
	}
	return an
}

// approximateLDSAnalyses returns the two analyses the analyzer flags, one per
// honesty claim, which together are the whole population so the two flags cannot be
// confused.
func approximateLDSAnalyses(t *testing.T) (phaseModel, granularity ldsbank.Analysis) {
	t.Helper()
	mk := func(opcode uint8, pc uint64) ldsbank.Analysis {
		t.Helper()
		access := ldsbank.Access{PC: pc, Opcode: opcode, Exec: ^uint64(0)}
		for lane := 0; lane < ldsbank.WavefrontLanes; lane++ {
			access.Addr[lane][0] = uint32(4 * lane)
		}
		an, ok := ldsbank.Analyze(access)
		if !ok {
			t.Fatalf("opcode %d is not a DS access this analyzer models", opcode)
		}
		return an
	}
	return mk(255, 0x2000), mk(30, 0x3000)
}

// recordSyntheticLDS pushes count executions of one analysis straight into the
// package-level recorder under task IDs firstTaskID..firstTaskID+count-1, and
// returns a Harness over it. requireRecorderEmpty is the precondition, and the
// returned harness's drain is the cleanup.
func recordSyntheticLDS(t *testing.T, an ldsbank.Analysis, firstTaskID uint64, count int) *Harness {
	t.Helper()
	requireRecorderEmpty(t)
	for i := range count {
		ldsbank.Record(an, firstTaskID+uint64(i))
	}
	return New(withLDS(Config{}))
}

// Instances cannot substitute Count for it: Count says how often a pattern ran,
// Instances is the join back to the wavefronts it ran on, and the timeline is built
// on that join.
func TestLDSAnalysisPopulatesInstances(t *testing.T) {
	h := loadLDSConflictFixture(t)

	report := h.LDSAnalysis()

	seen := 0
	for _, p := range report.Patterns {
		if len(p.Instances) == 0 {
			t.Errorf("pattern %s at pc %#x: instances is empty; the join back to "+
				"the wavefront trace is what the timeline needs, and a nil slice "+
				"marshals as null", p.Name, p.PC)
		}
		if uint64(len(p.Instances)) > p.Count {
			t.Errorf("pattern %s: %d instances for a count of %d", p.Name, len(p.Instances), p.Count)
		}
		seen += len(p.Instances)
	}
	if seen != len(h.ldsIndex()) {
		t.Errorf("report carries %d instance ids, index has %d entries; the two "+
			"views came from different drains", seen, len(h.ldsIndex()))
	}
}

// The untruncated state on the real fixture: one wavefront, one execution, one
// instance, and nothing dropped. Pinned separately from the clipped state so a
// change to either is attributable.
func TestLDSAnalysisInstancesUntruncatedOnOneWave(t *testing.T) {
	h := loadLDSConflictFixture(t)

	report := h.LDSAnalysis()

	for _, p := range report.Patterns {
		if p.InstancesTruncated {
			t.Errorf("pattern %s: instancesTruncated set on a single-wavefront run", p.Name)
		}
		if len(p.Instances) != int(p.Count) {
			t.Errorf("pattern %s: %d instances for a count of %d, and nothing was "+
				"reported truncated", p.Name, len(p.Instances), p.Count)
		}
	}
	if got := report.Stats.TruncatedInstances; got != 0 {
		t.Errorf("stats.truncatedInstances = %d, want 0 for a one-wavefront run", got)
	}
}

// The clipped state. A pattern can report count 200 and carry 64 instances, and
// that is exactly what InstancesTruncated is for -- the alternative, a count with
// an absent instance list, describes data that is not there. The cap is the
// analyzer's DefaultMaxInstances, which the harness does not get to choose.
func TestLDSAnalysisInstancesReportTheClippedState(t *testing.T) {
	const executions = 200
	an := ldsConflictAnalysis(t)
	h := recordSyntheticLDS(t, an, 9000, executions)

	report := h.LDSAnalysis()

	if len(report.Patterns) != 1 {
		t.Fatalf("patterns = %d, want 1", len(report.Patterns))
	}
	p := report.Patterns[0]
	if p.Count != executions {
		t.Errorf("count = %d, want %d: the count must stay exact even when the "+
			"instance list is clipped", p.Count, executions)
	}
	if len(p.Instances) != ldsbank.DefaultMaxInstances {
		t.Errorf("instances = %d, want the analyzer's cap of %d", len(p.Instances),
			ldsbank.DefaultMaxInstances)
	}
	if !p.InstancesTruncated {
		t.Error("instancesTruncated is false although 200 executions were recorded " +
			"and only 64 instance ids fit")
	}
	if got := report.Stats.TruncatedInstances; got != executions-ldsbank.DefaultMaxInstances {
		t.Errorf("stats.truncatedInstances = %d, want %d", got, executions-ldsbank.DefaultMaxInstances)
	}
	// The clipped list is still a real list: the first id is the first execution
	// recorded, not a placeholder.
	if len(p.Instances) == 0 || p.Instances[0] != 9000 {
		t.Errorf("instances do not start at the first recorded task id: %v", p.Instances)
	}
	for i, id := range p.Instances {
		if want := uint64(9000 + i); id != want {
			t.Fatalf("instances[%d] = %d, want %d: the clipped list is a prefix, "+
				"not a resampling", i, id, want)
		}
	}
}

// Pins the LdsInst payload field by field: the key, the pattern index and the
// read/write label are all part of the timeline's join.
func TestLDSIndexJoinsEachInstanceToItsOwnPattern(t *testing.T) {
	h := loadLDSConflictFixture(t)

	report := h.LDSAnalysis()
	index := h.ldsIndex()

	// The fixture must yield one read and one write pattern, or the Read label
	// below is free to be wrong for the only row that exists.
	var readPattern, writePattern = -1, -1
	for i, p := range report.Patterns {
		if p.IsRead {
			readPattern = i
		} else {
			writePattern = i
		}
	}
	if readPattern < 0 || writePattern < 0 {
		t.Fatalf("fixture must yield one read and one write pattern, got read=%d write=%d",
			readPattern, writePattern)
	}

	// The whole payload, field for field, against the report's own view: the key is
	// the analyzer's InstTaskID, the index is the row the instance belongs to, and
	// Read and Degree are that row's values.
	want := make(map[uint64]LdsInst)
	for i, p := range report.Patterns {
		for _, id := range p.Instances {
			want[id] = LdsInst{Found: true, Read: p.IsRead, Degree: p.Degree, Pattern: i}
		}
	}
	if len(want) == 0 {
		t.Fatal("the fixture recorded no instances, so the index has nothing to pin")
	}
	if len(index) != len(want) {
		t.Fatalf("index has %d entries, report names %d distinct instance task ids; "+
			"the key of the join is not the analyzer's InstTaskID", len(index), len(want))
	}
	for id, exp := range want {
		got, ok := index[id]
		if !ok {
			t.Errorf("index is missing task %d", id)
			continue
		}
		if got != exp {
			t.Errorf("index[%d] = %+v, want %+v", id, got, exp)
		}
	}

	// The read/write split itself, so inverting Read on every row cannot pass: the
	// two PCs must disagree, each instance following its own pattern.
	labels := map[bool]bool{}
	for _, inst := range index {
		labels[inst.Read] = true
	}
	if !labels[true] || !labels[false] {
		t.Errorf("index labels present: read=%v write=%v, want both", labels[true], labels[false])
	}
}

// Drives the two opcodes the analyzer actually flags, since the fixture is entirely
// b32 and both flags are otherwise always false.
func TestLDSAnalysisCarriesTheHonestyMarkersFromTheAnalyzer(t *testing.T) {
	phaseModel, granularity := approximateLDSAnalyses(t)
	requireRecorderEmpty(t)
	ldsbank.Record(phaseModel, 7001)
	ldsbank.Record(granularity, 7002)
	h := New(withLDS(Config{}))

	report := h.LDSAnalysis()
	if len(report.Patterns) != 2 {
		t.Fatalf("patterns = %d, want 2", len(report.Patterns))
	}

	b128 := report.Patterns[0]
	if b128.Name != "ds_read_b128" || !b128.PhaseModelApproximate || b128.AddressGranularityApproximate {
		t.Errorf("pattern %s: phaseModelApproximate=%v addressGranularityApproximate=%v, "+
			"want true/false -- the b128 read phase grouping is the inferred one, and "+
			"the two claims are separate fields for exactly this reason",
			b128.Name, b128.PhaseModelApproximate, b128.AddressGranularityApproximate)
	}
	b8 := report.Patterns[1]
	if b8.Name != "ds_write_b8" || b8.PhaseModelApproximate || !b8.AddressGranularityApproximate {
		t.Errorf("pattern %s: phaseModelApproximate=%v addressGranularityApproximate=%v, "+
			"want false/true -- sub-word granularity is the inferred one",
			b8.Name, b8.PhaseModelApproximate, b8.AddressGranularityApproximate)
	}

	// And the same two fields under their wire names, from a real drain rather than
	// from a struct literal.
	raw, err := json.Marshal(report.Patterns)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wire []map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(wire) != 2 {
		t.Fatalf("wire has %d patterns", len(wire))
	}
	for i, want := range []bool{true, false} {
		if got := wire[i]["phaseModelApproximate"]; got != want {
			t.Errorf("patterns[%d].phaseModelApproximate = %v, want %v", i, got, want)
		}
	}
	for i, want := range []bool{false, true} {
		if got := wire[i]["addressGranularityApproximate"]; got != want {
			t.Errorf("patterns[%d].addressGranularityApproximate = %v, want %v", i, got, want)
		}
	}
}

// A map miss must be detectable rather than silently reported as a degree: the
// timeline looks up every span it closes, most of which are not LDS.
func TestLDSIndexReportsAMissRatherThanDegreeZero(t *testing.T) {
	h := loadLDSConflictFixture(t)

	index := h.ldsIndex()

	// A task id no execution of this kernel can have: the recorder keys on the
	// tracing task id, and the two the fixture reports are real. Any id outside that
	// set is a miss.
	present := make(map[uint64]bool, len(index))
	for id := range index {
		present[id] = true
	}
	var miss uint64 = 1 << 40
	for present[miss] {
		miss++
	}

	got, ok := index[miss]
	if ok {
		t.Fatalf("task %d is in the index but the fixture never recorded it", miss)
	}
	if got.Found {
		t.Errorf("index[%d] = %+v: a miss must not claim Found", miss, got)
	}
	if got.Degree != 0 {
		t.Errorf("index[%d].Degree = %d, want 0", miss, got.Degree)
	}
	// Degree is 0 on a miss, and 0 must never reach the UI, so Found is the only
	// distinction and every caller has to check it. Every key the analyzer did name
	// is a hit, so Found is not simply always true.
	for id, inst := range index {
		if !inst.Found {
			t.Errorf("index[%d].Found = false although the analyzer recorded it", id)
		}
	}
}

// bankAddrFixture is the per-bank distinct-address count the JSON contract spec
// carries: bank 0 is 4 deep, bank 7 holds one address, the rest of the row is
// empty. Bank 0 is what makes the phase's degree 4. The expected JSON is derived
// from this array rather than written out as a second 32-element literal.
func bankAddrFixture() [ldsbank.NumBanks]int {
	var counts [ldsbank.NumBanks]int
	counts[0] = 4
	counts[7] = 1
	return counts
}

func bankAddrJSONText(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(bankAddrFixture())
	if err != nil {
		t.Fatalf("marshal bankAddrs fixture: %v", err)
	}
	return string(raw)
}

func bankAddrJSONFixture() []any {
	out := make([]any, ldsbank.NumBanks)
	for b, n := range bankAddrFixture() {
		out[b] = float64(n)
	}
	return out
}

// Marshals a pattern with every field set and pins the object it produces.
func TestLDSPatternJSONContract(t *testing.T) {
	pattern := LdsPattern{
		PC:                            0x4074,
		Name:                          "ds_read_b128",
		IsRead:                        true,
		Degree:                        4,
		Stride:                        128,
		UniformStride:                 true,
		PhaseModelApproximate:         true,
		AddressGranularityApproximate: true,
		Phases:                        []LdsPhase{{FirstLane: 0, LastLane: 7, Lanes: []int{0, 1}, Degree: 4, BankAddrs: bankAddrFixture()}},
		Lanes:                         []LdsLane{{Lane: 0, Bank: 0, Phase: 0, Addrs: []uint32{0x40, 0x80}}},
		RepIsFirstSeen:                true,
		SourceFile:                    "ldsconflict.cu",
		SourceLine:                    52,
		Count:                         200,
		Instances:                     []uint64{7},
		InstancesTruncated:            true,
	}

	raw, err := json.Marshal(pattern)
	if err != nil {
		t.Fatalf("marshal LdsPattern: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal back: %v", err)
	}

	want := map[string]any{
		"pc":                            float64(0x4074),
		"sourceFile":                    "ldsconflict.cu",
		"sourceLine":                    float64(52),
		"name":                          "ds_read_b128",
		"isRead":                        true,
		"degree":                        float64(4),
		"stride":                        float64(128),
		"uniformStride":                 true,
		"phaseModelApproximate":         true,
		"addressGranularityApproximate": true,
		"phases": []any{map[string]any{
			"firstLane": float64(0), "lastLane": float64(7),
			"lanes": []any{float64(0), float64(1)}, "degree": float64(4),
			"bankAddrs": bankAddrJSONFixture(),
		}},
		"lanes": []any{map[string]any{
			"lane": float64(0), "bank": float64(0), "phase": float64(0),
			"addrs": []any{float64(0x40), float64(0x80)},
		}},
		"repIsFirstSeen":     true,
		"count":              float64(200),
		"instances":          []any{float64(7)},
		"instancesTruncated": true,
	}
	for key, value := range want {
		actual, present := got[key]
		if !present {
			t.Errorf("JSON has no key %q; keys are %v", key, jsonKeys(got))
			continue
		}
		if !reflect.DeepEqual(actual, value) {
			t.Errorf("JSON[%q] = %#v, want %#v", key, actual, value)
		}
	}
	// Exactly the contract, so a field added under a new key is a deliberate act
	// rather than something that slips past this spec.
	if len(got) != len(want) {
		t.Errorf("JSON has %d keys (%v), want %d -- a new field must be added here too",
			len(got), jsonKeys(got), len(want))
	}
	if got["instances"] == nil {
		t.Error("instances serialized as null; the join back to the wavefront trace " +
			"is what the timeline is built on")
	}

	// The two nested types carry keys of their own. bankAddrs is a full 32-entry array
	// even for an 8-lane b128 phase, because a row is 32 banks wide whatever the
	// access does and the UI indexes it by bank.
	phase, err := json.Marshal(pattern.Phases[0])
	if err != nil {
		t.Fatalf("marshal LdsPhase: %v", err)
	}
	if string(phase) != `{"firstLane":0,"lastLane":7,"lanes":[0,1],"degree":4,"bankAddrs":`+
		bankAddrJSONText(t)+`}` {
		t.Errorf("LdsPhase JSON = %s", phase)
	}
	lane, err := json.Marshal(pattern.Lanes[0])
	if err != nil {
		t.Fatalf("marshal LdsLane: %v", err)
	}
	if string(lane) != `{"lane":0,"bank":0,"phase":0,"addrs":[64,128]}` {
		t.Errorf("LdsLane JSON = %s", lane)
	}
	if empty, err := json.Marshal(LdsLane{Lane: 1, Bank: 0, Phase: 0}); err != nil {
		t.Fatalf("marshal LdsLane with no addresses: %v", err)
	} else if !strings.Contains(string(empty), `"addrs":null`) {
		t.Errorf("a lane with no addresses marshals as %s, want an explicit null so a host can tell it from an offset of 0", empty)
	}

	// Stats keys too, since the report wrapper nests them.
	stats, err := json.Marshal(LdsStats{Patterns: 1, DroppedExecutions: 2, TruncatedInstances: 3})
	if err != nil {
		t.Fatalf("marshal LdsStats: %v", err)
	}
	if string(stats) != `{"patterns":1,"droppedExecutions":2,"truncatedInstances":3}` {
		t.Errorf("LdsStats JSON = %s", stats)
	}
	report, err := json.Marshal(LdsAnalysisReport{
		Patterns: []LdsPattern{},
		Stats:    LdsStats{Patterns: 1, DroppedExecutions: 2, TruncatedInstances: 3},
	})
	if err != nil {
		t.Fatalf("marshal LdsAnalysisReport: %v", err)
	}
	// patterns is [] and not null: the drain always makes the slice.
	if string(report) != `{"patterns":[],"stats":{"patterns":1,"droppedExecutions":2,"truncatedInstances":3}}` {
		t.Errorf("LdsAnalysisReport JSON = %s", report)
	}
}

// RepIsFirstSeen is the claim the UI renders next to the bank map. The fixture below
// manufactures its case: two executions of the same static instruction whose per-lane
// addresses differ but whose phase degrees are identical, so they share a grouping key
// and land in one row whose Rep is the first of them.
func TestLDSAnalysisSaysTheBankMapIsTheFirstSeenMember(t *testing.T) {
	// lane L at byte 8L: bank 2L mod 32, so each 32-lane phase is 2-way and both
	// phases report degree 2. The second execution nudges phase 1 up by one dword,
	// which moves its banks to odd numbers without changing any degree, so the two
	// share a key and cannot be told apart by anything but their addresses. The
	// nudge has to be a whole dword: a bank is selected by (addr/4) mod 32, so a
	// byte-sized nudge would move no bank at all.
	access := func(pc uint64, phase1Dwords int) ldsbank.Access {
		a := ldsbank.Access{PC: pc, Opcode: 13, Exec: ^uint64(0)}
		for lane := range ldsbank.WavefrontLanes {
			a.Addr[lane][0] = uint32(8*lane + 4*phase1Dwords*btoi(lane >= 32))
		}
		return a
	}
	firstAccess := access(0x1234, 0)
	secondAccess := access(0x1234, 1)

	first, ok := ldsbank.Analyze(firstAccess)
	if !ok {
		t.Fatal("opcode 13 is not a DS access this analyzer models")
	}
	second, ok := ldsbank.Analyze(secondAccess)
	if !ok {
		t.Fatal("opcode 13 is not a DS access this analyzer models")
	}

	// Preconditions, or the assertions below would pass for the wrong reason.
	sameDegrees := len(first.Phases) == len(second.Phases)
	for i := range first.Phases {
		if first.Phases[i].Degree != second.Phases[i].Degree {
			sameDegrees = false
		}
	}
	if !sameDegrees {
		t.Fatalf("test setup: phase degrees %v vs %v; the two executions must share "+
			"a grouping key for this to be the heterogeneous-group case", first.Degree, second.Degree)
	}
	differing := -1
	for lane := range ldsbank.WavefrontLanes {
		if first.LaneBank[lane] != second.LaneBank[lane] {
			differing = lane
			break
		}
	}
	if differing < 0 {
		t.Fatal("test setup: both executions produce the same bank map, so nothing " +
			"distinguishes the first-seen member from the last-seen one")
	}

	requireRecorderEmpty(t)
	ldsbank.Record(first, 9101)
	ldsbank.Record(second, 9102)
	h := New(withLDS(Config{}))

	report := h.LDSAnalysis()
	if len(report.Patterns) != 1 {
		t.Fatalf("patterns = %d, want 1: two executions at one PC with equal degrees "+
			"are one reporting row, which is the whole point", len(report.Patterns))
	}
	p := report.Patterns[0]
	if p.Count != 2 {
		t.Errorf("count = %d, want 2: the row groups both executions", p.Count)
	}

	if !p.RepIsFirstSeen {
		t.Errorf("pattern %s at pc %#x: repIsFirstSeen is false; the UI renders this "+
			"claim next to the bank map, and the bank map is one member of a group "+
			"whose other members are not summarised", p.Name, p.PC)
	}

	// The map is the first execution's, not the second's and not a merge. Pinned per
	// lane, because one agreeing phase would hide a last-seen draw.
	if len(p.Lanes) != ldsbank.WavefrontLanes {
		t.Fatalf("lane rows = %d, want %d", len(p.Lanes), ldsbank.WavefrontLanes)
	}
	for lane, row := range p.Lanes {
		if row.Bank != first.LaneBank[lane] {
			t.Fatalf("pattern %s lane %d: bank = %d, want %d. The first execution "+
				"puts it at %d and the second at %d, so the map is neither the "+
				"first-seen member nor a summary of the group",
				p.Name, lane, row.Bank, first.LaneBank[lane],
				first.LaneBank[lane], second.LaneBank[lane])
		}
	}
	if p.Lanes[differing].Bank == second.LaneBank[differing] {
		t.Fatalf("lane %d: the report drew the second execution's bank; the two agree "+
			"on every other lane, so this is the only place the choice is visible", differing)
	}

	// And under the wire name, from the real drain rather than a struct literal.
	wire := marshalPatternFields(t, p)
	if got := wire["repIsFirstSeen"]; got != true {
		t.Errorf("repIsFirstSeen = %v, want true on the wire", got)
	}
}

// DroppedExecutions is the report's only word for "the analyzer hit its pattern cap
// and threw executions away". On any normal kernel it is legitimately zero, so only
// a run past DefaultMaxPatterns can prove the copy happened.
func TestLDSAnalysisCarriesTheDrainStats(t *testing.T) {
	// One access geometry, 300 distinct PCs. The grouping key includes the PC, so
	// every execution names a new key: the first DefaultMaxPatterns become rows
	// and the rest increment the dropped counter.
	const executions = 300
	an := ldsConflictAnalysis(t)
	requireRecorderEmpty(t)
	for i := range executions {
		a := an
		a.PC = uint64(0x4000 + i)
		ldsbank.Record(a, uint64(1000+i))
	}
	h := New(withLDS(Config{}))

	report := h.LDSAnalysis()

	if got, want := report.Stats.Patterns, uint64(ldsbank.DefaultMaxPatterns); got != want {
		t.Errorf("stats.patterns = %d, want %d -- the analyzer keeps rows up to its "+
			"cap, and the report must count the rows it actually got back", got, want)
	}
	if got, want := report.Stats.Patterns, uint64(len(report.Patterns)); got != want {
		t.Errorf("stats.patterns = %d but the report holds %d rows; the two describe "+
			"the same drain and cannot disagree", got, want)
	}
	wantDropped := uint64(executions - ldsbank.DefaultMaxPatterns)
	if got := report.Stats.DroppedExecutions; got != wantDropped {
		t.Errorf("stats.droppedExecutions = %d, want %d (%d executions past the "+
			"cap of %d). It counts executions, not patterns, and it is the only "+
			"signal the report has that the recorder was capped",
			got, wantDropped, executions, ldsbank.DefaultMaxPatterns)
	}
	// One execution per pattern here, so nothing was clipped: the third stat must
	// not absorb the second one's number.
	if got := report.Stats.TruncatedInstances; got != 0 {
		t.Errorf("stats.truncatedInstances = %d, want 0: every pattern has a single "+
			"execution, so nothing was clipped", got)
	}

	// The real fixture, so the zero case is pinned too: a drain that dropped
	// nothing must say so rather than leave the field unexamined.
	fixtureReport := loadLDSConflictFixture(t).LDSAnalysis()
	if got, want := fixtureReport.Stats.Patterns, uint64(len(fixtureReport.Patterns)); got != want {
		t.Errorf("ldsconflict: stats.patterns = %d, want %d", got, want)
	}
	if got := fixtureReport.Stats.DroppedExecutions; got != 0 {
		t.Errorf("ldsconflict: stats.droppedExecutions = %d, want 0: two instructions "+
			"is nowhere near the cap of %d", got, ldsbank.DefaultMaxPatterns)
	}

	// And under the wire names.
	envelope := marshalReportEnvelope(t, report)
	stats := unmarshalLdsStats(t, envelope["stats"])
	if stats.Patterns != report.Stats.Patterns || stats.DroppedExecutions != report.Stats.DroppedExecutions {
		t.Errorf("stats on the wire = %+v, want %+v", stats, report.Stats)
	}
}

// Both polarities are needed. The fixture supplies the true one: ldsconflict steps
// 8 bytes per lane, so every consecutive pair in every phase shares the stride. The
// false one comes from a synthetic access whose first phase is irregular, which also
// pins the first-phase scope, because its second phase is uniform.
func TestLDSAnalysisUniformStrideIsTheFirstPhasesVerdict(t *testing.T) {
	// Uniform, on the real fixture.
	fixtureReport := loadLDSConflictFixture(t).LDSAnalysis()
	if len(fixtureReport.Patterns) == 0 {
		t.Fatal("ldsconflict recorded no patterns, so the uniform case is unexamined")
	}
	for _, p := range fixtureReport.Patterns {
		if !p.UniformStride {
			t.Errorf("pattern %s: uniformStride is false, but every consecutive lane "+
				"pair in the phase steps %d bytes (stride %d), so it is uniform",
				p.Name, p.Stride, p.Stride)
		}
	}

	// Irregular first phase, uniform second phase: lane 1 is displaced, so phase 0
	// does not step evenly and phase 1 does.
	access := ldsbank.Access{PC: 0x5000, Opcode: 13, Exec: ^uint64(0)}
	for lane := range ldsbank.WavefrontLanes {
		access.Addr[lane][0] = uint32(4 * lane)
	}
	access.Addr[1][0] = 12
	an, ok := ldsbank.Analyze(access)
	if !ok {
		t.Fatal("opcode 13 is not a DS access this analyzer models")
	}
	if an.Phases[0].UniformStride {
		t.Fatalf("test setup: phase 0 is uniform, so there is no false case to reach")
	}

	requireRecorderEmpty(t)
	ldsbank.Record(an, 9201)
	h := New(withLDS(Config{}))

	report := h.LDSAnalysis()
	if len(report.Patterns) != 1 {
		t.Fatalf("patterns = %d, want 1", len(report.Patterns))
	}
	p := report.Patterns[0]
	if p.UniformStride {
		t.Errorf("pattern %s: uniformStride is true, but the first phase is irregular "+
			"(stride %d, and the lanes after the displaced one step %d). The field is "+
			"the FIRST phase's verdict by contract, so a uniform later phase must not "+
			"change it", p.Name, p.Stride, 4)
	}

	wire := marshalPatternFields(t, p)
	if got := wire["uniformStride"]; got != false {
		t.Errorf("uniformStride = %v, want false on the wire", got)
	}
}

// bankCountMax is the largest per-bank distinct-address count a phase reported.
func bankCountMax(counts [ldsbank.NumBanks]int) int {
	worst := 0
	for _, n := range counts {
		if n > worst {
			worst = n
		}
	}
	return worst
}

// The map is drawn from per-bank distinct-address counts. ldsconflict steps 8 bytes
// per lane, so a 32-lane phase puts two lanes in each of the 16 even banks at two
// DIFFERENT addresses and nothing in the odd banks. In the analyzer the degree IS
// the largest of these counts, so a copy that could disagree with it would be worse
// than no copy at all.
func TestLDSAnalysisCarriesPerBankAddressCounts(t *testing.T) {
	h := loadLDSConflictFixture(t)

	report := h.LDSAnalysis()
	if len(report.Patterns) == 0 {
		t.Fatal("ldsconflict recorded no patterns, so there are no counts to check")
	}

	for _, p := range report.Patterns {
		if len(p.Phases) == 0 {
			t.Fatalf("pattern %s: no phases recorded", p.Name)
		}
		for i, ph := range p.Phases {
			counts := ph.BankAddrs

			if got := bankCountMax(counts); got != ph.Degree {
				t.Errorf("pattern %s phase %d: the largest per-bank count is %d but the "+
					"phase degree is %d. The degree is that maximum in the analyzer, so a "+
					"disagreement means the map would draw a depth the heading does not claim: %v",
					p.Name, i, got, ph.Degree, counts)
			}

			// Some bank is 2-way conflicted, which is the fixture's whole point.
			deep := 0
			for b, n := range counts {
				switch {
				case n == 2:
					deep++
				case n > 2:
					t.Errorf("pattern %s phase %d: bank %d reports %d distinct addresses, "+
						"but the pattern is 2-way conflicted by construction", p.Name, i, b, n)
				case n < 0 || n > 1:
					t.Errorf("pattern %s phase %d: bank %d reports %d, want 0 or 1", p.Name, i, b, n)
				}
			}
			if deep == 0 {
				t.Errorf("pattern %s phase %d: no bank reports 2 distinct addresses, so the "+
					"counts do not describe the conflict the degree reports: %v", p.Name, i, counts)
			}
			// 32 lanes at an 8-byte stride reach 16 banks, two addresses each, and
			// leave the other 16 empty.
			if deep != ldsbank.NumBanks/2 {
				t.Errorf("pattern %s phase %d: %d banks report 2 distinct addresses, want %d "+
					"(32 lanes stepping 8 bytes reach the 16 even banks two deep)", p.Name, i, deep,
					ldsbank.NumBanks/2)
			}
		}
	}

	// And under the wire name, from a real drain rather than a struct literal.
	wire := marshalPatternFields(t, report.Patterns[0])
	raw, ok := wire["phases"].([]any)
	if !ok || len(raw) == 0 {
		t.Fatalf("phases on the wire = %v, want a non-empty array", wire["phases"])
	}
	first, ok := raw[0].(map[string]any)
	if !ok {
		t.Fatalf("phases[0] on the wire is not an object")
	}
	counts, ok := first["bankAddrs"].([]any)
	if !ok {
		t.Fatalf("phases[0].bankAddrs = %v, want an array of per-bank counts", first["bankAddrs"])
	}
	if len(counts) != ldsbank.NumBanks {
		t.Errorf("phases[0].bankAddrs has %d entries, want one per bank (%d)", len(counts),
			ldsbank.NumBanks)
	}
	for b, n := range counts {
		if n.(float64) != float64(report.Patterns[0].Phases[0].BankAddrs[b]) {
			t.Errorf("bank %d: wire %v, drain %d", b, n, report.Patterns[0].Phases[0].BankAddrs[b])
		}
	}
}

// 64 lanes reading ONE address is a broadcast: the hardware serves it in a single
// cycle and the degree is 1. Per-lane bank occupancy would make bank 0 the most
// crowded bank in the ISA; a per-bank distinct-address count must say 1 there, 0
// everywhere else, and leave the access conflict-free.
func TestLDSAnalysisCountsABroadcastAsOneAddress(t *testing.T) {
	const opcodeReadB32 = 54
	access := ldsbank.Access{PC: 0x6000, Opcode: opcodeReadB32, Exec: ^uint64(0)}
	// Every lane at byte 0. Leave Addr's zero value alone: one address for all 64.
	an, ok := ldsbank.Analyze(access)
	if !ok {
		t.Fatalf("opcode %d is not a DS access this analyzer models", opcodeReadB32)
	}

	requireRecorderEmpty(t)
	ldsbank.Record(an, 9301)
	h := New(withLDS(Config{}))

	report := h.LDSAnalysis()
	if len(report.Patterns) != 1 {
		t.Fatalf("patterns = %d, want 1", len(report.Patterns))
	}
	p := report.Patterns[0]
	if p.Degree != 1 {
		t.Fatalf("test setup: a 64-lane broadcast of one address is degree 1, got %d", p.Degree)
	}
	if len(p.Lanes) != ldsbank.WavefrontLanes {
		t.Fatalf("lane rows = %d, want %d: the occupancy this must NOT be confused with "+
			"is every lane landing in bank 0", len(p.Lanes), ldsbank.WavefrontLanes)
	}
	for _, lane := range p.Lanes {
		if lane.Bank != 0 {
			t.Fatalf("test setup: lane %d is in bank %d, want 0", lane.Lane, lane.Bank)
		}
	}

	for i, ph := range p.Phases {
		// The 64 lanes are here; the one address is what the phase serves them from.
		if len(ph.Lanes) != 32 {
			t.Errorf("phase %d: lanes = %d, want 32", i, len(ph.Lanes))
		}
		if got := ph.BankAddrs[0]; got != 1 {
			t.Errorf("phase %d: bank 0 reports %d distinct addresses, want 1. 32 lanes "+
				"at one address is a broadcast the hardware serves in one cycle; counting "+
				"them would report a 32-way conflict for the cheapest access in the ISA",
				i, got)
		}
		for b := 1; b < ldsbank.NumBanks; b++ {
			if got := ph.BankAddrs[b]; got != 0 {
				t.Errorf("phase %d: bank %d reports %d distinct addresses, want 0: no lane "+
					"reaches it", i, b, got)
			}
		}
	}
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// marshalPatternFields renders one drained pattern as the UI receives it, so a
// field can be checked under its wire name from a real drain. A struct literal
// cannot see a copy the drain deleted.
func marshalPatternFields(t *testing.T, p LdsPattern) map[string]any {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal pattern %s: %v", p.Name, err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal pattern %s: %v", p.Name, err)
	}
	return out
}

func marshalReportEnvelope(t *testing.T, report LdsAnalysisReport) map[string]json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal report envelope: %v", err)
	}
	return out
}

func rawMessageKeys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func unmarshalLdsStats(t *testing.T, raw json.RawMessage) LdsStats {
	t.Helper()
	var stats LdsStats
	if err := json.Unmarshal(raw, &stats); err != nil {
		t.Fatalf("unmarshal stats: %v", err)
	}
	return stats
}

func jsonKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// bank = (byte address / 4) mod 32 is the single hardware fact this feature exists
// to teach. ldsconflict steps 8 bytes per lane from the base of the tile, so lane L
// sits at dword 2L and therefore at bank 2L mod 32. The phase boundary is lane 32,
// because a b32 access serves 128 bytes, one full row, per phase.
func TestLDSAnalysisPinsTheBankMap(t *testing.T) {
	h := loadLDSConflictFixture(t)

	report := h.LDSAnalysis()

	for _, p := range report.Patterns {
		if len(p.Lanes) != ldsbank.WavefrontLanes {
			t.Fatalf("pattern %s: %d lane rows, want %d", p.Name, len(p.Lanes),
				ldsbank.WavefrontLanes)
		}
		for i, lane := range p.Lanes {
			if lane.Lane != i {
				t.Fatalf("pattern %s: row %d is lane %d; the rows are built by "+
					"walking a [64]int and are expected in ascending lane order",
					p.Name, i, lane.Lane)
			}
			if want := (2 * i) % ldsbank.NumBanks; lane.Bank != want {
				t.Errorf("pattern %s lane %d: bank = %d, want %d (byte address %d, "+
					"so (addr/4) mod 32)", p.Name, i, lane.Bank, want, 8*i)
			}
			if want := i / 32; lane.Phase != want {
				t.Errorf("pattern %s lane %d: phase = %d, want %d", p.Name, i, lane.Phase, want)
			}
		}

		// The phase boundary itself, named: lane 31 closes phase 0 and lane 32 opens
		// phase 1. A phase width that drifts would satisfy neither.
		for _, tc := range []struct{ lane, phase int }{{0, 0}, {31, 0}, {32, 1}, {63, 1}} {
			if got := p.Lanes[tc.lane].Phase; got != tc.phase {
				t.Errorf("pattern %s: lane %d is in phase %d, want %d", p.Name, tc.lane, got, tc.phase)
			}
		}
		// And the addresses the phase bounds claim agree with the phase the lane
		// rows assigned, so the two halves of the pattern cannot disagree.
		for i, ph := range p.Phases {
			if ph.FirstLane != i*32 || ph.LastLane != i*32+31 {
				t.Errorf("pattern %s phase %d spans lanes %d..%d, want %d..%d",
					p.Name, i, ph.FirstLane, ph.LastLane, i*32, i*32+31)
			}
			for _, lane := range ph.Lanes {
				if lane < ph.FirstLane || lane > ph.LastLane {
					t.Errorf("pattern %s phase %d lists lane %d, outside its own "+
						"range %d..%d", p.Name, i, lane, ph.FirstLane, ph.LastLane)
				}
			}
		}
	}
}
