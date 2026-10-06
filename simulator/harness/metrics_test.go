package harness

import (
	"testing"

	"github.com/sarchlab/akita/v5/mem/memprotocol"
	"github.com/sarchlab/akita/v5/tracing"
)

// countWrite drives one req_in write through a tracer and returns what it charged.
func countWrite(data []byte, dirtyMask []bool) (bytes uint64, transactions int) {
	tr := newDramTracer()
	tr.StartTask(tracing.TaskStart{
		ID: 1, Kind: "req_in", Detail: memprotocol.WriteReq{Data: data, DirtyMask: dirtyMask},
	})
	tr.EndTask(tracing.TaskEnd{ID: 1})
	return tr.writeSize, tr.writeCount
}

// A masked write carries a whole line's buffer but writes only the bytes the mask
// names.
func TestAMaskedWriteIsChargedOnlyItsDirtyBytes(t *testing.T) {
	t.Parallel()

	line := make([]byte, 64)
	half := make([]bool, 64)
	for i := range half {
		half[i] = i < 32
	}

	if got, _ := countWrite(line, half); got != 32 {
		t.Errorf("a half-line write charged %d bytes, want the 32 the mask names", got)
	}

	// The two shapes a full-line write arrives in, both of which must still charge
	// every byte: no mask at all, and a mask that is true throughout. The second
	// matters because "absent mask" and "all-dirty mask" mean the same thing to the
	// memory controller and must not come out different here.
	if got, _ := countWrite(line, nil); got != 64 {
		t.Errorf("an unmasked write charged %d bytes, want 64", got)
	}
	all := make([]bool, 64)
	for i := range all {
		all[i] = true
	}
	if got, _ := countWrite(line, all); got != 64 {
		t.Errorf("an all-dirty write charged %d bytes, want 64", got)
	}
}

// A masked write is still one transaction; only its bytes shrink.
func TestAMaskedWriteIsStillOneTransaction(t *testing.T) {
	t.Parallel()

	data := make([]byte, 64)
	mask := make([]bool, 64)
	mask[0] = true
	if _, transactions := countWrite(data, mask); transactions != 1 {
		t.Errorf("a masked write counted %d transactions, want 1", transactions)
	}
}

// A mask longer than the data is malformed: counting its tail would invent bytes
// with no buffer behind them.
func TestAMaskLongerThanTheDataDoesNotInventBytes(t *testing.T) {
	t.Parallel()

	data := make([]byte, 8)
	mask := make([]bool, 16)
	for i := range mask {
		mask[i] = true
	}
	if got, _ := countWrite(data, mask); got != 8 {
		t.Errorf("an over-long mask charged %d bytes, want the 8 the data holds", got)
	}
}

// A request reaches a tracer as whatever the sender put in the message, because
// TraceReqReceive stores it as an `any`. Both shapes are real: the vector
// coalescer allocates &ReadReq / &WriteReq and lets the message carry the pointer
// onward (mgpusim/amd/timing/cu/defaultcoalescer.go:139,158).
func TestARequestIsCountedWhicheverWayItArrives(t *testing.T) {
	t.Parallel()

	data := make([]byte, 64)
	mask := make([]bool, 64)
	for i := range mask {
		mask[i] = true
	}

	cases := []struct {
		name      string
		detail    any
		wantRead  uint64
		wantWrite uint64
		wantTxn   int
	}{
		{"value read", memprotocol.ReadReq{AccessByteSize: 64}, 64, 0, 1},
		{"pointer read", &memprotocol.ReadReq{AccessByteSize: 64}, 64, 0, 1},
		{"value write", memprotocol.WriteReq{Data: data, DirtyMask: mask}, 0, 64, 1},
		{"pointer write", &memprotocol.WriteReq{Data: data, DirtyMask: mask}, 0, 64, 1},
		// A typed nil pointer is what a sender that stored a nil *WriteReq hands
		// over. It must count nothing rather than dereference nil and take the
		// process down in the middle of a run.
		{"nil pointer write", (*memprotocol.WriteReq)(nil), 0, 0, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tr := newDramTracer()
			tr.StartTask(tracing.TaskStart{ID: 1, Kind: "req_in", Detail: tc.detail})
			tr.EndTask(tracing.TaskEnd{ID: 1})

			if txns := tr.readCount + tr.writeCount; txns != tc.wantTxn {
				t.Errorf("counted %d transactions, want %d", txns, tc.wantTxn)
			}
			if tr.readSize != tc.wantRead {
				t.Errorf("read %d bytes, want %d", tr.readSize, tc.wantRead)
			}
			if tr.writeSize != tc.wantWrite {
				t.Errorf("wrote %d bytes, want %d", tr.writeSize, tc.wantWrite)
			}
		})
	}
}

// The instances here carry wildly different rates on purpose: a test where every CU
// agreed would pass whether or not pooling happens.
func TestCacheHitRateIsPooledAcrossComputeUnitsNotLastOneWins(t *testing.T) {
	pooled := poolCacheSamples([]cacheSample{
		{label: "L1V", hits: 900, total: 1000}, // busy CU, poor rate
		{label: "L1V", hits: 1, total: 1},      // quiet CU, perfect rate
		{label: "L1V", hits: 5, total: 10},     // middle CU, middling rate
	})
	if len(pooled) != 1 {
		t.Fatalf("expected one pooled L1V entry, got %d: %+v", len(pooled), pooled)
	}
	if pooled[0].name != "L1V" {
		t.Fatalf("pooled entry is labelled %q, want L1V", pooled[0].name)
	}
	want := 906.0 / 1011.0
	if pooled[0].hitRate != want {
		t.Fatalf("pooled hit rate %v, want %v: the figure is being taken from one CU rather than pooled",
			pooled[0].hitRate, want)
	}
	// Neither a single CU's rate (1.0 or 0.9) nor an unweighted mean of the three.
	if pooled[0].hitRate == 1.0 || pooled[0].hitRate == 0.9 {
		t.Fatalf("hit rate %v matches a single CU, so instances are not pooled", pooled[0].hitRate)
	}
	unweighted := (0.9 + 1.0 + 0.5) / 3
	if pooled[0].hitRate == unweighted {
		t.Fatalf("hit rate %v is the unweighted mean of means, which over-weights the quiet CU", pooled[0].hitRate)
	}
}

func TestCacheLatencyIsTransactionWeighted(t *testing.T) {
	pooled := poolCacheSamples([]cacheSample{
		{label: "L1V", hits: 5, total: 10, avgLatencyNS: 100}, // slow, busy
		{label: "L1V", hits: 5, total: 10, avgLatencyNS: 10},  // fast, busy
		{label: "L1V", hits: 0, total: 2, avgLatencyNS: 1},    // fast, nearly idle
	})
	if len(pooled) != 1 {
		t.Fatalf("expected one entry, got %d", len(pooled))
	}
	// (100*10 + 10*10 + 1*2) / 22. An unweighted mean of means would be 37.
	want := (100.0*10 + 10.0*10 + 1.0*2) / 22.0
	if pooled[0].avgLatencyNS != want {
		t.Fatalf("pooled latency %v, want %v", pooled[0].avgLatencyNS, want)
	}
	if pooled[0].avgLatencyNS == 37 {
		t.Fatalf("latency is an unweighted mean of means")
	}
}

func TestCacheLevelsStayDistinctAfterPooling(t *testing.T) {
	pooled := poolCacheSamples([]cacheSample{
		{label: "L1V", hits: 8, total: 10},
		{label: "L1S", hits: 6, total: 10},
		{label: "L1I", hits: 1, total: 10},
		{label: "L2", hits: 7, total: 10},
	})
	got := map[string]float64{}
	for _, entry := range pooled {
		got[entry.name] = entry.hitRate
	}
	for name, want := range map[string]float64{"L1V": 0.8, "L1S": 0.6, "L1I": 0.1, "L2": 0.7} {
		if g, ok := got[name]; !ok {
			t.Fatalf("no %s entry in %v", name, got)
		} else if g != want {
			t.Fatalf("%s pooled to %v, want %v", name, g, want)
		}
	}
}

func TestCacheEntriesAreOrderedSoEveryRunEmitsTheSameWireOrder(t *testing.T) {
	// Map iteration order reaching the telemetry would make two identical runs
	// emit the same numbers in a different order, which is a diff nobody can read.
	want := []string{"L1I", "L1V", "L2"}
	for attempt := 0; attempt < 8; attempt++ {
		var names []string
		for _, entry := range poolCacheSamples([]cacheSample{
			{label: "L2", hits: 5, total: 10},
			{label: "L1I", hits: 5, total: 10},
			{label: "L1V", hits: 5, total: 10},
		}) {
			names = append(names, entry.name)
		}
		if len(names) != len(want) {
			t.Fatalf("got %v, want %v", names, want)
		}
		for i := range want {
			if names[i] != want[i] {
				t.Fatalf("attempt %d: entries came out %v, want %v", attempt, names, want)
			}
		}
	}
}

func TestPoolingIgnoresInstancesThatNeverSawATransaction(t *testing.T) {
	// A cache with no traffic has no rate to report. Dividing by its zero total
	// would be a NaN on the wire, and averaging in a zero would drag the level
	// down as if the cache had missed everything.
	pooled := poolCacheSamples([]cacheSample{
		{label: "L1V", hits: 8, total: 10},
		{label: "L1V", hits: 0, total: 0, avgLatencyNS: 0},
	})
	if len(pooled) != 1 || pooled[0].hitRate != 0.8 {
		t.Fatalf("an idle instance changed the pooled rate: %+v", pooled)
	}
}

func TestCacheLevelOf(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		want int
	}{
		{"GPU[0].L2Cache[3]", memLevelL2},
		{"GPU[0].SA[0].L1VCache[2]", memLevelL1},
		{"GPU[0].SA[0].L1SCache", memLevelL1},
		{"GPU[0].SA[0].L1ICache", memLevelL1},
		{"GPU[0].MALL[7]", memLevelMALL},
	}
	for _, tc := range tests {
		if got := cacheLevelOf(tc.name); got != tc.want {
			t.Errorf("cacheLevelOf(%q) = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// The label is what the live stream's map key and the finished body's
// hipy.cache.name attribute carry, so no level may fall through to its raw
// component name.
func TestEveryCacheLevelIsLabelledByItsOwnName(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct{ name, want string }{
		{"GPU[0].SA[0].L1VCache[2]", "L1V"},
		{"GPU[0].SA[0].L1SCache", "L1S"},
		{"GPU[0].SA[0].L1ICache", "L1I"},
		{"GPU[0].L2Cache[3]", "L2"},
		{"GPU[0].MALL[7]", "MALL"},
	} {
		if got := cacheLabel(tc.name); got != tc.want {
			t.Errorf("cacheLabel(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// MALL is not named "Cache", so the tracer-registration case has to match it
// separately.
func TestMALLIsRegisteredAsACache(t *testing.T) {
	t.Parallel()

	if !lastNameSegmentContains("GPU[0].MALL[0]", "MALL") {
		t.Error("MALL components must match the cache registration case")
	}
	// "GPU[0].L2ToDRAM" is a connection whose last segment does contain "L2". What
	// keeps it out of the cache cases is that it matches none of them, so this is
	// the assertion that actually protects it.
	if !lastNameSegmentContains("GPU[0].L2ToDRAM", "L2") {
		t.Error("precondition changed: L2ToDRAM should still match the L2 substring")
	}
	for _, c := range []string{"Cache", "MALL", "TLB", "DRAM["} {
		if lastNameSegmentContains("GPU[0].L2ToDRAM", c) {
			t.Errorf("connection L2ToDRAM matches tracing case %q; it must match none", c)
		}
	}
}

func TestCollectCacheBytesSeparatesLevels(t *testing.T) {
	t.Parallel()

	h := &Harness{hooks: &simHooks{}}
	add := func(level int, readSize, writeSize uint64) {
		tr := newDramTracer()
		tr.readSize, tr.writeSize = readSize, writeSize
		h.hooks.cacheBytes = append(h.hooks.cacheBytes,
			cacheBytesEntry{level: level, tracer: tr})
	}
	add(memLevelL1, 100, 10)
	add(memLevelL1, 200, 20)
	add(memLevelL2, 50, 5)

	got := h.collectCacheBytes()
	if got[memLevelL1].readBytes != 300 || got[memLevelL1].writeBytes != 30 {
		t.Errorf("L1 = %d read / %d write, want 300/30", got[memLevelL1].readBytes, got[memLevelL1].writeBytes)
	}
	if got[memLevelL2].readBytes != 50 {
		t.Errorf("L2 read = %d, want 50", got[memLevelL2].readBytes)
	}
	if got[memLevelMALL].readBytes != 0 {
		t.Errorf("MALL read = %d, want 0 when no MALL tracer is registered", got[memLevelMALL].readBytes)
	}
}

func TestHasMemLevel(t *testing.T) {
	t.Parallel()

	h := &Harness{hooks: &simHooks{}}
	if h.hasMemLevel(memLevelMALL) {
		t.Error("hasMemLevel(MALL) = true with no tracers registered")
	}
	h.hooks.cacheBytes = append(h.hooks.cacheBytes,
		cacheBytesEntry{level: memLevelL2, tracer: newDramTracer()})
	if !h.hasMemLevel(memLevelL2) {
		t.Error("hasMemLevel(L2) = false with an L2 tracer registered")
	}
	if h.hasMemLevel(memLevelMALL) {
		t.Error("hasMemLevel(MALL) = true; an L2 tracer must not imply a MALL")
	}
}

func TestMemLevelDataPointsCoversPresentLevelsOnly(t *testing.T) {
	t.Parallel()

	var collected collectedMetrics
	collected.memLevels[memLevelL1] = collectedDRAMStats{readBytes: 100, writeBytes: 10}
	collected.memLevels[memLevelL2] = collectedDRAMStats{readBytes: 50, writeBytes: 5}
	collected.memLevelPresent[memLevelL1] = true
	collected.memLevelPresent[memLevelL2] = true
	// MALL deliberately left absent: this is the R9 Nano's shape.

	pickBytes := func(st collectedDRAMStats) (uint64, uint64) { return st.readBytes, st.writeBytes }
	points := memLevelDataPoints(1, 1, collected, pickBytes)

	if len(points) != 4 {
		t.Fatalf("got %d data points, want 4 (two levels x read/write)", len(points))
	}
	levels := map[string]int{}
	for _, dp := range points {
		for _, kv := range dp.Attributes {
			if kv.Key == "hipy.mem.level" {
				levels[kv.Value.GetStringValue()]++
			}
		}
	}
	if levels[memLevelNames[memLevelMALL]] != 0 {
		t.Error("a MALL data point was emitted for a device with no MALL")
	}
	for _, name := range []string{"L1", "L2"} {
		if levels[name] != 2 {
			t.Errorf("level %s got %d data points, want 2", name, levels[name])
		}
	}

	// The same device with a MALL must grow a row, not overwrite one.
	collected.memLevelPresent[memLevelMALL] = true
	if got := len(memLevelDataPoints(1, 1, collected, pickBytes)); got != 6 {
		t.Errorf("with a MALL the body has %d data points, want 6", got)
	}
}
