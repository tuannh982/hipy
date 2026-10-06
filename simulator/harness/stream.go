package harness

import (
	"encoding/json"
	"time"
)

// MetricsSink receives a small JSON body describing the run so far, several
// times a second, WHILE the kernel is still running.
//
// A package-level variable because the harness builds and runs natively under
// `go test`, and only the wasm layer has any way to call into JavaScript. A nil
// sink -- the native default -- costs nothing.
var MetricsSink func(payload []byte)

// Metrics is one sample. Cumulative fields are to-date totals, exactly as the
// OTLP body reports them, and the browser differences consecutive samples
// rather than reading a rate off a single one.
//
// Not OTLP: these are gauges the browser polls while it watches, not a wire
// contract a collector ingests.
type Metrics struct {
	// The engine's clock, the only denominator a DRAM rate can honestly use.
	SimTimePs uint64 `json:"simTimePs"`
	// The engine clock when the launch was enqueued, so elapsed time can be
	// measured from the kernel rather than from the engine's first tick: the
	// H2D copies ahead of a launch advance the clock. Zero before the first
	// launch, which is a real state rather than a missing value.
	LaunchSimTimePs uint64 `json:"launchSimTimePs"`
	// That launch command's busy time, which is what CPI is computed from.
	KernelTimePs uint64 `json:"kernelTimePs"`

	// The host's own allocation ledger against the device's modelled memory.
	// See usedDeviceMemory on the gap to the allocator's own figure.
	VRAMUsedBytes     uint64 `json:"vramUsedBytes"`
	VRAMCapacityBytes uint64 `json:"vramCapacityBytes"`

	DRAMReadBytes  uint64 `json:"dramReadBytes"`
	DRAMWriteBytes uint64 `json:"dramWriteBytes"`

	// The same two totals measured from the launch rather than from the start of
	// the program, which is what a panel watching a kernel plots. The copies and
	// memsets ahead of the launch are themselves DRAM traffic and land on the
	// absolute pair, so they would sit on the kernel's line as a fixed offset.
	DRAMReadSinceLaunchBytes  uint64 `json:"dramReadSinceLaunchBytes"`
	DRAMWriteSinceLaunchBytes uint64 `json:"dramWriteSinceLaunchBytes"`
	DRAMReadTransactions      uint64 `json:"dramReadTransactions"`
	DRAMWriteTransactions     uint64 `json:"dramWriteTransactions"`

	// The same two quantities one and two levels up the hierarchy, as requests
	// ARRIVED at each level from below -- a store L2 absorbed is counted here at
	// L1 and L2 and never appears at DRAM.
	//
	// A map because the hierarchy differs by device: CDNA3 has a MALL between L2
	// and DRAM and the R9 Nano has nothing there. A level the device lacks is
	// absent from the map rather than reported as zero.
	//
	// L1 sums every L1 in the device, since one L1 row is what a reader wants;
	// the finished body's CacheHitRate keeps them apart.
	MemLevels map[string]MemLevelSample `json:"memLevels,omitempty"`

	// What each kernel moved, over every launch of it; the figures above are the
	// current launch's alone.
	KernelTraffic []KernelTraffic `json:"kernelTraffic,omitempty"`

	// CUs with at least one non-idle SIMD lane, which is "issuing or holding a
	// wavefront" rather than "has retired an instruction".
	ActiveCUs int `json:"activeCus"`
	TotalCUs  int `json:"totalCus"`
	// The same question one level down, and the one that shows imbalance inside a
	// single compute unit.
	ActiveSIMDs int `json:"activeSimds"`
	TotalSIMDs  int `json:"totalSimds"`

	Waves        int    `json:"waves"`
	Instructions uint64 `json:"instructions"`

	// Keyed by level (L1V, L1S, L1I, L2) and pooled per level, as the finished
	// body pools it. A level with no traffic yet is absent rather than zero.
	CacheHitRate map[string]float64 `json:"cacheHitRate"`
	TLBHitRate   float64            `json:"tlbHitRate"`
}

// flushInterval is the minimum wall time between flushes; flushStride is how many
// retired instructions must pass before the clock is read at all.
//
// Both, because they bound different costs. The stride keeps time.Now() off the
// per-instruction path, and the interval sets the rate: a stride alone would
// flush thousands of times a second. The interval is a floor, not a schedule.
//
// The stride is also a floor on whether a kernel reports anything: the first
// offer always flushes, so a stride above a kernel's instruction count means no
// samples at all. 256 is measured, not guessed. The interval is 40ms because a
// sample count is the run's wall duration over it and nothing else -- at 200ms
// the cheap examples (0.4s) produced four points, which is not a series.
const (
	flushInterval = 40 * time.Millisecond
	flushStride   = 256
)

// flusher paces the stream. Its fields are read and written only from the engine
// goroutine -- MGPUSim is built here with a SerialEngine (harness.go builds
// without parallelEngine), so there is one writer and no mutex.
type flusher struct {
	harness *Harness
	stride  int
	lastAt  time.Time
	// The engine clock at the previous publish, so EmitFinalSample can tell a real
	// advance from a repeated drain.
	lastEmitPs uint64
}

// streamHook is the stream hook for this harness's instruction tracers, or nil
// when no sink is installed.
//
// A method rather than `h.stream.offer` at the call site because a method value
// on a nil pointer is not nil: `h.stream.offer` on a nil receiver yields a good
// function value, the tracer's nil guard passes, and the first retired
// instruction dereferences nil.
func (h *Harness) streamHook() func() {
	if h.stream == nil {
		return nil
	}
	return h.stream.offer
}

// offer is the tracing hook's entry point: one call per retired instruction,
// which is the most reliable heartbeat available. Nothing fires often enough on
// a kernel that spends its time in memory, and nothing fires on the timer at all
// -- under wasm the runtime is cooperative, so a time.Ticker's JS continuation
// cannot run while the simulation owns the stack.
func (f *flusher) offer() {
	f.stride++
	if f.stride < flushStride {
		return
	}
	f.stride = 0
	if MetricsSink == nil {
		return
	}
	if !f.lastAt.IsZero() && time.Since(f.lastAt) < flushInterval {
		return
	}
	f.lastAt = time.Now()
	f.lastEmitPs = uint64(f.harness.sim.GetEngine().CurrentTime())
	f.harness.emitSample()
}

// EmitFinalSample publishes one last sample, outside any pacing, and is what the
// wasm layer calls after Drain.
//
// A run's last writes land after the pacing has stopped, and there is no idle
// flush in the writeback path: akita's flusher runs only on a Flush command
// (third_party/akita/mem/cache/writeback/flusher.go:30). Dirty data leaves L2 by
// eviction under pressure or because the host read the range back, and the second
// is what a program does when it copies its results out: a kernel launch marks the
// buffer set L2-dirty (mgpusim/amd/driver/driver.go:411) and a copy overlapping a
// dirty buffer issues CmdDrain -> CmdFlush -> CmdInvalidate before it copies
// (memorycopy.go:151). So the flush that moves a kernel's output to DRAM is
// triggered by the program's own copy, and completes during the Drain this sample
// is taken after.
func (h *Harness) EmitFinalSample() {
	if h == nil || h.stream == nil || MetricsSink == nil {
		return
	}
	// Skipped when the clock has not moved AND no launch has been retired since the
	// last sample, so a second drain of an unchanged simulation does not append a
	// duplicate point.
	if now := uint64(h.sim.GetEngine().CurrentTime()); now == h.stream.lastEmitPs && !h.kernelTrafficDirty {
		return
	} else {
		h.stream.lastEmitPs = now
	}
	h.emitSample()
	h.kernelTrafficDirty = false
}

// emitSample samples and publishes one body.
//
// It runs on the engine goroutine because that is the goroutine that writes every
// counter read here: akita's BusyTimeTracer has no lock at all
// (third_party/akita/tracing/busytimetracer.go) and the SIMD units' IsIdle mutates
// the field it reports, so sampling from outside would be a data race.
//
// It must not be called while a tracer's lock is held, which is why offer is
// invoked from EndTask after its mutex is released: marshalling under a
// non-reentrant mutex deadlocks.
func (h *Harness) emitSample() {
	payload, err := json.Marshal(h.sampleMetrics())
	if err != nil || len(payload) == 0 {
		return
	}
	MetricsSink(payload)
}

// MemLevelSample is one level's traffic in the memory hierarchy. The SinceLaunch
// pair is what the panel plots, measured from the launch for the reason given on
// the DRAM fields: the host's copies and memsets ahead of the launch are
// themselves traffic at every level.
type MemLevelSample struct {
	ReadBytes         uint64 `json:"readBytes"`
	WriteBytes        uint64 `json:"writeBytes"`
	ReadSinceLaunch   uint64 `json:"readSinceLaunchBytes"`
	WriteSinceLaunch  uint64 `json:"writeSinceLaunchBytes"`
	ReadTransactions  uint64 `json:"readTransactions"`
	WriteTransactions uint64 `json:"writeTransactions"`
}

// memLevelSamples builds the per-level map, omitting levels this device does not
// have rather than reporting them as zero.
func (h *Harness) memLevelSamples(cacheBytes [memLevelCount]collectedDRAMStats) map[string]MemLevelSample {
	out := make(map[string]MemLevelSample, memLevelCount)
	for level := 0; level < memLevelCount; level++ {
		if !h.hasMemLevel(level) {
			continue
		}
		st := cacheBytes[level]
		out[memLevelNames[level]] = MemLevelSample{
			ReadBytes:         st.readBytes,
			WriteBytes:        st.writeBytes,
			ReadSinceLaunch:   saturatingSub(st.readBytes, h.launchCacheReadBytes[level]),
			WriteSinceLaunch:  saturatingSub(st.writeBytes, h.launchCacheWriteBytes[level]),
			ReadTransactions:  st.readTransactions,
			WriteTransactions: st.writeTransactions,
		}
	}
	return out
}

// sampleMetrics reads one sample. Everything cumulative comes from the same
// collectors the finished OTLP body uses, so a live figure and the number the
// Report tab settles on cannot disagree about how to compute it.
func (h *Harness) sampleMetrics() Metrics {
	// Before the snapshot, so the per-kernel figures include everything the kernel in
	// flight has done up to this instant rather than up to the previous sample.
	h.attributePendingTraffic()

	dram := h.collectDRAM()
	cacheBytes := h.collectCacheBytes()
	caches := h.collectCaches()

	hitRates := make(map[string]float64, len(caches))
	for _, entry := range caches {
		hitRates[entry.name] = entry.hitRate
	}

	activeCUs, activeSIMDs, totalSIMDs := h.activeLanes()

	var instructions uint64
	for _, c := range h.hooks.instCounters {
		instructions += c.tracer.count.Load()
	}

	return Metrics{
		SimTimePs:         uint64(h.sim.GetEngine().CurrentTime()),
		LaunchSimTimePs:   h.lastLaunchSimTimePs,
		KernelTimePs:      uint64(h.hooks.kernelTime.BusyTime()),
		VRAMUsedBytes:     h.usedDeviceMemory(),
		VRAMCapacityBytes: h.vramCapacity,
		DRAMReadBytes:     dram.readBytes,
		DRAMWriteBytes:    dram.writeBytes,
		// Floored at zero for the same reason the browser floors a delta: a
		// negative total on a chart is a line under the floor.
		DRAMReadSinceLaunchBytes:  saturatingSub(dram.readBytes, h.launchDramReadBytes),
		DRAMWriteSinceLaunchBytes: saturatingSub(dram.writeBytes, h.launchDramWriteBytes),
		DRAMReadTransactions:      dram.readTransactions,
		DRAMWriteTransactions:     dram.writeTransactions,

		MemLevels:     h.memLevelSamples(cacheBytes),
		KernelTraffic: h.kernelTrafficSnapshot(),
		ActiveCUs:     activeCUs,
		TotalCUs:      len(h.hooks.instCounters),
		ActiveSIMDs:   activeSIMDs,
		TotalSIMDs:    totalSIMDs,
		Waves:         h.waveCount(),
		Instructions:  instructions,
		CacheHitRate:  hitRates,
		TLBHitRate:    h.tlbHitRate(),
	}
}

// activeLanes counts compute units and SIMD lanes that are not idle.
//
// IsIdle is the right question rather than "has an in-flight memory request",
// which the ComputeUnit also exposes: a lane can be several instructions into a
// VALU op with nothing in flight and still be very much busy, and a memory-only
// question would call that lane idle.
func (h *Harness) activeLanes() (activeCUs, activeSIMDs, totalSIMDs int) {
	for _, c := range h.hooks.instCounters {
		if c.mw == nil {
			continue
		}
		cuActive := false
		for _, lane := range c.mw.SIMDUnit {
			totalSIMDs++
			if lane.IsIdle() {
				continue
			}
			activeSIMDs++
			cuActive = true
		}
		if cuActive {
			activeCUs++
		}
	}
	return activeCUs, activeSIMDs, totalSIMDs
}

// saturatingSub is `a - b` that stops at zero.
func saturatingSub(a, b uint64) uint64 {
	if a <= b {
		return 0
	}
	return a - b
}
