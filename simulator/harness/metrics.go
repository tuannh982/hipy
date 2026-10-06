package harness

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/sarchlab/akita/v5/mem/memprotocol"
	"github.com/sarchlab/akita/v5/simulation"
	"github.com/sarchlab/akita/v5/timing"
	"github.com/sarchlab/akita/v5/tracing"
	"github.com/sarchlab/mgpusim/v5/amd/timing/cu"
)

type collectedMetrics struct {
	kernelName        string
	kernelTimeNS      uint64
	totalInstructions uint64
	waves             int
	cus               []collectedCUMetrics
	cpiStack          []collectedCPIEntry
	caches            []collectedCacheEntry
	tlbHitRate        float64
	dram              collectedDRAMStats
	// memLevels is indexed by the memLevel* constants, so an absent level is simply
	// left at zero AND unlisted: memLevelPresent says which levels this device built.
	memLevels       [memLevelCount]collectedDRAMStats
	memLevelPresent [memLevelCount]bool
}

type collectedCUMetrics struct {
	id        int
	instCount uint64
	cpi       float64
	simds     []collectedSIMDMetrics
}

type collectedSIMDMetrics struct {
	id        int
	instCount uint64
	cpi       float64
}

type collectedCPIEntry struct {
	reason        string
	cyclesPerInst float64
}

type collectedCacheEntry struct {
	name         string
	hitRate      float64
	avgLatencyNS float64
}

type collectedDRAMStats struct {
	readBytes         uint64
	writeBytes        uint64
	readTransactions  uint64
	writeTransactions uint64
}

// initHooks registers the telemetry tracers on the freshly built platform,
// mirroring amd/samples/runner/report.go minus the datarecording machinery.
func (h *Harness) initHooks() {
	s := h.sim
	h.hooks = &simHooks{}

	h.hooks.kernelTime = newKernelTimeTracer()
	tracing.CollectTrace(h.driver, h.hooks.kernelTime)

	for _, comp := range s.Components() {
		name := comp.Name()
		switch {
		case isCUName(name) && isTimingCU(comp):
			cuComp := comp.(*cu.Comp)
			cuMW := cu.MiddlewareOf(cuComp)

			instT := newInstCountTracer(h.streamHook())
			tracing.CollectTrace(cuComp, instT)
			h.hooks.instCounters = append(h.hooks.instCounters,
				cuInstCounter{cu: cuComp, mw: cuMW, tracer: instT})

			waveT := &waveCountTracer{}
			tracing.CollectTrace(cuComp, waveT)
			h.hooks.waveCounters = append(h.hooks.waveCounters, waveT)

			cpiT := cu.NewCPIStackInstHook(cuComp, s.GetEngine())
			tracing.CollectTrace(cuComp, cpiT)
			h.hooks.cpiStacks = append(h.hooks.cpiStacks,
				cuCPIStack{cu: cuComp, tracer: cpiT})

			for i, simdUnit := range cuMW.SIMDUnit {
				simd, ok := simdUnit.(tracing.NamedHookable)
				if !ok {
					continue
				}
				// Register the wrapper, not the inner BusyTimeTracer: its
				// StartTask counts "pipeline" tasks before delegating.
				tr := newSIMDBusyTracer()
				tracing.CollectTrace(simd, tr)
				h.hooks.simdTime = append(h.hooks.simdTime,
					simdTimeEntry{cu: cuComp, simdIndex: i, tracer: tr})
			}
		case lastNameSegmentContains(name, "Cache"),
			// MALL is a cache but is not named one: the component is
			// "GPU[0].MALL[0]", so the "Cache" case alone misses it.
			lastNameSegmentContains(name, "MALL"):
			latT := tracing.NewAverageTimeTracer(func(task tracing.TaskStart) bool {
				return task.Kind == "req_in"
			})
			tracing.CollectTrace(comp.(tracing.NamedHookable), latT)

			tagT := tracing.NewTagCountTracer(func(task tracing.TaskStart) bool {
				return true
			})
			tracing.CollectTrace(comp.(tracing.NamedHookable), tagT)

			h.hooks.caches = append(h.hooks.caches,
				cacheTracer{cache: comp.(tracing.NamedHookable),
					latency: latT, tags: tagT})

			// Byte traffic offered to this cache, so the panel can show the
			// L1 -> L2 -> DRAM hierarchy instead of only the last hop. dramTracer
			// counts req_in bytes, so the L2 figure is what all the L1s asked of it
			// and the DRAM figure is what L2 asked of memory.
			bt := newDramTracer()
			tracing.CollectTrace(comp.(tracing.NamedHookable), bt)
			h.hooks.cacheBytes = append(h.hooks.cacheBytes,
				cacheBytesEntry{level: cacheLevelOf(name), tracer: bt})
		case lastNameSegmentContains(name, "TLB"):
			tagT := tracing.NewTagCountTracer(func(task tracing.TaskStart) bool {
				return true
			})
			tracing.CollectTrace(comp.(tracing.NamedHookable), tagT)
			h.hooks.tlbs = append(h.hooks.tlbs,
				tlbTracer{tlb: comp.(tracing.NamedHookable), tags: tagT})
		case lastNameSegmentContains(name, "DRAM["):
			dt := newDramTracer()
			tracing.CollectTrace(comp.(tracing.NamedHookable), dt)
			h.hooks.drams = append(h.hooks.drams, dt)
		}
	}
}

// lastNameSegmentContains reports whether the final dot-separated segment of a
// component name contains sub: "GPU[1].SA[0].L1VTLB[0]" matches "TLB".
//
// The final segment only, so a prefix elsewhere in the name cannot match by
// accident. Note what it does NOT do: the last segment of "GPU[1].L2ToDRAM" is
// "L2ToDRAM", which contains "L2". Connections are kept out of the tracing cases
// below because they match none of them, not by this function.
func lastNameSegmentContains(name, sub string) bool {
	seg := name
	if i := strings.LastIndex(name, "."); i >= 0 {
		seg = name[i+1:]
	}
	return strings.Contains(seg, sub)
}

// cacheLevelOf reports which level of the hierarchy a cache component sits at, from
// its name, as one of the memLevel* constants.
//
// The levels are not the same set on every device, which is why this is a
// classification rather than an index: CDNA3 puts a MALL between L2 and DRAM and
// the R9 Nano does not. Absent levels stay absent and the panel draws only the
// rows a device has.
func cacheLevelOf(name string) int {
	switch {
	case lastNameSegmentContains(name, "MALL"):
		return memLevelMALL
	case lastNameSegmentContains(name, "L2"):
		return memLevelL2
	default:
		return memLevelL1
	}
}

// The memory hierarchy, ordered innermost first. MALL sits between L2 and DRAM and
// exists only on CDNA3.
const (
	memLevelL1 = iota
	memLevelL2
	memLevelMALL
	memLevelCount
)

// memLevelNames labels each level in the UI and in OTLP. The key is what the panel
// and the finished body use to look the level up.
var memLevelNames = [memLevelCount]string{"L1", "L2", "MALL"}

// hasMemLevel reports whether the device actually built this level, from whether any
// tracer was registered for it. A device with no MALL yields false here rather than
// a row of zeros.
func (h *Harness) hasMemLevel(level int) bool {
	for _, e := range h.hooks.cacheBytes {
		if e.level == level {
			return true
		}
	}
	return false
}

// *driver.Driver satisfies tracing.NamedHookable directly, so the driver takes
// tracers like any component.

func (h *Harness) collectMetrics() collectedMetrics {
	m := collectedMetrics{
		kernelName: h.lastKernelName,
		cus:        []collectedCUMetrics{},
		cpiStack:   []collectedCPIEntry{},
		caches:     []collectedCacheEntry{},
	}

	if h.hooks == nil {
		return m
	}

	m.kernelTimeNS = h.kernelTimeNSForCPI()
	m.totalInstructions = h.totalInstCount()
	m.waves = h.waveCount()
	m.cus = h.collectCUs()
	m.cpiStack = h.collectCPIStack()
	m.caches = h.collectCaches()
	m.tlbHitRate = h.tlbHitRate()
	m.dram = h.collectDRAM()
	m.memLevels = h.collectCacheBytes()
	for level := 0; level < memLevelCount; level++ {
		m.memLevelPresent[level] = h.hasMemLevel(level)
	}

	return m
}

func picoToNS(t timing.VTimeInPicoSec) uint64 {
	return uint64(t) / 1000
}

// kernelTimeNSForCPI is the driver's LaunchKernelCommand task's busy time.
func (h *Harness) kernelTimeNSForCPI() uint64 {
	return picoToNS(h.hooks.kernelTime.BusyTime())
}

// totalInstCount sums the retired-instruction counts of all CU tracers.
func (h *Harness) totalInstCount() uint64 {
	var total uint64
	for _, c := range h.hooks.instCounters {
		total += c.tracer.count.Load()
	}
	return total
}

// waveCount sums the wavefront-start counts of all CU tracers. A work group of
// B work-items opens ceil(B/64) of them, so this is the number of wavefronts
// dispatched.
func (h *Harness) waveCount() int {
	var total uint64
	for _, c := range h.hooks.waveCounters {
		total += c.count.Load()
	}
	return int(total)
}

// collectCUs builds per-CU metrics. Instruction-level CPI uses the runner's
// formula: simulated seconds × CU frequency (Hz) / instruction count
// (amd/samples/runner/report.go:415-461; secondsOf converts the BusyTimeTracer's
// picoseconds with a 1e-12 factor). Per-SIMD counts come from the per-SIMD
// pipeline BusyTimeTracers' task counts. IDs are globally unique across all
// shader arrays (SA_index*CUsPerSA + per-SA CU index, see globalCUIndex).
func (h *Harness) collectCUs() []collectedCUMetrics {
	cus := make([]collectedCUMetrics, 0, len(h.hooks.instCounters))
	kernelTimePS := h.hooks.kernelTime.BusyTime()
	cusPerSA := h.cusPerSA()

	for _, c := range h.hooks.instCounters {
		freq := float64(c.cu.Spec().Freq)
		inst := c.tracer.count.Load()

		cpi := 0.0
		if inst > 0 {
			cpi = float64(kernelTimePS) * 1e-12 * freq / float64(inst)
		}

		cm := collectedCUMetrics{
			id:        globalCUIndex(c.cu.Name(), cusPerSA),
			instCount: inst,
			cpi:       cpi,
			simds:     []collectedSIMDMetrics{},
		}
		for _, st := range h.hooks.simdTime {
			if st.cu != c.cu {
				continue
			}
			sm := collectedSIMDMetrics{
				id:        st.simdIndex,
				instCount: st.tracer.count.Load(),
			}
			if sm.instCount > 0 {
				sm.cpi = float64(kernelTimePS) * 1e-12 * freq /
					float64(sm.instCount)
			}
			cm.simds = append(cm.simds, sm)
		}
		cus = append(cus, cm)
	}

	sort.Slice(cus, func(i, j int) bool { return cus[i].id < cus[j].id })
	return cus
}

// cuIndex extracts the per-SA CU index from a name like "GPU[1].SA[0].CU[3]".
func cuIndex(name string) int {
	const sep = ".CU["
	i := strings.LastIndex(name, sep)
	if i < 0 {
		return 0
	}
	j := strings.LastIndex(name, "]")
	if j <= i+len(sep) {
		return 0
	}
	n, err := strconv.Atoi(name[i+len(sep) : j])
	if err != nil {
		return 0
	}
	return n
}

// globalCUIndex maps a CU name to a globally unique id:
// SA_index*CUsPerSA + per-SA CU index ("GPU[1].SA[2].CU[3]" is 11 with 4 CUs per
// SA). Per-SA ids alone would collide 16-way across the shader arrays.
func globalCUIndex(name string, cusPerSA int) int {
	const saSep = ".SA["
	sa := 0
	if i := strings.LastIndex(name, saSep); i >= 0 {
		rest := name[i+len(saSep):]
		if j := strings.Index(rest, "]"); j > 0 {
			if n, err := strconv.Atoi(rest[:j]); err == nil {
				sa = n
			}
		}
	}
	return sa*cusPerSA + cuIndex(name)
}

// cusPerSA reads the CUs per shader array from the platform's own component
// names: the highest observed per-SA CU index plus one. Falls back to 1.
func (h *Harness) cusPerSA() int {
	maxIdx := 0
	for _, c := range h.hooks.instCounters {
		if idx := cuIndex(c.cu.Name()) + 1; idx > maxIdx {
			maxIdx = idx
		}
	}
	if maxIdx == 0 {
		return 1
	}
	return maxIdx
}

// collectCPIStack sums the per-CU CPI stacks and maps the tracer's bucket names
// onto the website's reason vocabulary. Values are cycles per instruction,
// already normalized by the tracer; CUs that retired nothing are skipped.
//
// Aggregation happens on the MAPPED reason, not the raw bucket, and the "total"
// row is the whole-window sum rather than a stall reason, so it is dropped.
func (h *Harness) collectCPIStack() []collectedCPIEntry {
	agg := map[string]float64{}
	count := 0
	for _, cs := range h.hooks.cpiStacks {
		stack := cs.tracer.GetCPIStack()
		if math.IsNaN(stack["total"]) || stack["total"] == 0 {
			continue
		}
		count++
		for bucket, cpi := range stack {
			if bucket == "total" {
				continue
			}
			agg[cpiReason(bucket)] += cpi
		}
	}
	if count == 0 {
		return []collectedCPIEntry{}
	}

	entries := make([]collectedCPIEntry, 0, len(agg))
	for reason, cpi := range agg {
		entries = append(entries, collectedCPIEntry{
			reason:        reason,
			cyclesPerInst: cpi / float64(count),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].reason < entries[j].reason
	})
	return entries
}

// cpiReason maps CPIStackTracer bucket names onto the website's reason
// vocabulary. Unmapped buckets (ScalarInst, VALU) collapse into "other".
func cpiReason(bucket string) string {
	switch bucket {
	case "Fetch":
		return "inst_fetch"
	case "VMem", "VMemInst", "ScalarMem", "ScalarMemInst":
		return "data_mem_wait"
	case "LDS":
		return "lds"
	case "Branch":
		return "barrier"
	case "Special", "Idle":
		return "hw_resource"
	default:
		return "other"
	}
}

// collectCaches assembles a hit rate and average latency for each cache LEVEL,
// pooled across every instance of it.
//
// Pooling happens here, while the counts still exist: averaging per-CU
// percentages downstream would weight a quiet CU equally with a busy one, and no
// weight reaches the wire.
func (h *Harness) collectCaches() []collectedCacheEntry {
	samples := make([]cacheSample, 0, len(h.hooks.caches))
	for _, ct := range h.hooks.caches {
		readHit := ct.tags.GetTagCount("read-hit")
		readMiss := ct.tags.GetTagCount("read-miss")
		readMSHRHit := ct.tags.GetTagCount("read-mshr-hit")
		writeHit := ct.tags.GetTagCount("write-hit")
		writeMiss := ct.tags.GetTagCount("write-miss")
		writeMSHRHit := ct.tags.GetTagCount("write-mshr-hit")

		total := readHit + readMiss + readMSHRHit +
			writeHit + writeMiss + writeMSHRHit
		if total == 0 {
			continue
		}
		samples = append(samples, cacheSample{
			label:        cacheLabel(ct.cache.Name()),
			hits:         readHit + readMSHRHit + writeHit + writeMSHRHit,
			total:        total,
			avgLatencyNS: float64(picoToNS(ct.latency.AverageTime())),
		})
	}
	return poolCacheSamples(samples)
}

// cacheSample is one cache instance's counts, reduced to what pooling needs.
// Split out so pooling is a pure function of numbers.
type cacheSample struct {
	label        string
	hits         uint64
	total        uint64
	avgLatencyNS float64
}

// poolCacheSamples folds per-instance samples into one entry per level. Hit rate
// is hits over transactions summed across instances, and latency is the
// transaction-weighted mean -- never a mean of means, which would weigh a CU that
// served three requests equally with one that served three thousand. Sorted by
// name so map iteration order cannot reach the telemetry.
func poolCacheSamples(samples []cacheSample) []collectedCacheEntry {
	type acc struct {
		hits            uint64
		total           uint64
		latencyWeighted float64
	}
	byLevel := map[string]*acc{}
	for _, sample := range samples {
		if sample.total == 0 {
			continue
		}
		a := byLevel[sample.label]
		if a == nil {
			a = &acc{}
			byLevel[sample.label] = a
		}
		a.hits += sample.hits
		a.total += sample.total
		a.latencyWeighted += sample.avgLatencyNS * float64(sample.total)
	}
	entries := make([]collectedCacheEntry, 0, len(byLevel))
	for label, a := range byLevel {
		entries = append(entries, collectedCacheEntry{
			name:         label,
			hitRate:      float64(a.hits) / float64(a.total),
			avgLatencyNS: a.latencyWeighted / float64(a.total),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })
	return entries
}

// cacheLabel shortens component names to the website's cache labels: L1V for
// the per-CU vector caches, L2 for the L2 banks, MALL for the Infinity Cache.
func cacheLabel(name string) string {
	switch {
	case strings.Contains(name, "L1VCache"):
		return "L1V"
	case strings.Contains(name, "L1SCache"):
		return "L1S"
	case strings.Contains(name, "L1ICache"):
		return "L1I"
	case strings.Contains(name, "L2Cache"):
		return "L2"
	case strings.Contains(name, "MALL"):
		return "MALL"
	default:
		return name
	}
}

// tlbHitRate returns the traffic-weighted pooled TLB hit rate: hit counts
// (including MSHR hits) summed across all TLBs, divided by the summed
// translation counts, not an average of the per-TLB rates. Mirrors
// report.go:595-635.
func (h *Harness) tlbHitRate() float64 {
	var hits, miss, mshrHit, numTLBs uint64
	for _, tt := range h.hooks.tlbs {
		tagHit := tt.tags.GetTagCount("hit")
		tagMiss := tt.tags.GetTagCount("miss")
		tagMSHRHit := tt.tags.GetTagCount("mshr-hit")
		if tagHit+tagMiss+tagMSHRHit == 0 {
			continue
		}
		hits += tagHit
		miss += tagMiss
		mshrHit += tagMSHRHit
		numTLBs++
	}
	if numTLBs == 0 {
		return 0
	}
	return float64(hits+mshrHit) / float64(hits+miss+mshrHit)
}

// collectCacheBytes aggregates request bytes by cache level. Level 1 sums every L1
// in the device (the L1V, L1S and L1I of every shader array) because the panel
// draws one L1 row.
func (h *Harness) collectCacheBytes() [memLevelCount]collectedDRAMStats {
	var out [memLevelCount]collectedDRAMStats
	for _, e := range h.hooks.cacheBytes {
		if e.level < 0 || e.level >= memLevelCount {
			continue
		}
		e.tracer.mu.Lock()
		out[e.level].readBytes += e.tracer.readSize
		out[e.level].writeBytes += e.tracer.writeSize
		out[e.level].readTransactions += uint64(e.tracer.readCount)
		out[e.level].writeTransactions += uint64(e.tracer.writeCount)
		e.tracer.mu.Unlock()
	}
	return out
}

// collectDRAM aggregates traffic across the memory controllers.
func (h *Harness) collectDRAM() collectedDRAMStats {
	var s collectedDRAMStats
	for _, dt := range h.hooks.drams {
		dt.mu.Lock()
		s.readBytes += dt.readSize
		s.writeBytes += dt.writeSize
		s.readTransactions += uint64(dt.readCount)
		s.writeTransactions += uint64(dt.writeCount)
		dt.mu.Unlock()
	}
	return s
}

// cuInstCounter pairs a CU with its instruction-count tracer and its middleware.
// The middleware is cached because the live sample reads its SIMD units on every
// flush and MiddlewareOf walks the middleware list.
type cuInstCounter struct {
	cu     *cu.Comp
	mw     *cu.ComputeUnit
	tracer *instCountTracer
}

// cuCPIStack pairs a CU with its CPI-stack hook.
type cuCPIStack struct {
	cu     *cu.Comp
	tracer *cu.CPIStackTracer
}

// simdTimeEntry pairs a CU's SIMD unit with its pipeline busy-time tracer.
type simdTimeEntry struct {
	cu        *cu.Comp
	simdIndex int
	tracer    *simdBusyTracer
}

// cacheTracer pairs a cache with its latency and hit/miss tracers.
type cacheTracer struct {
	cache   tracing.NamedHookable
	latency *tracing.AverageTimeTracer
	tags    *tracing.TagCountTracer
}

// tlbTracer pairs a TLB with its hit/miss tag tracer.
type tlbTracer struct {
	tlb  tracing.NamedHookable
	tags *tracing.TagCountTracer
}

// hooks bundles everything initHooks registered.
type simHooks struct {
	kernelTime   *kernelTimeTracer
	instCounters []cuInstCounter
	waveCounters []*waveCountTracer
	cpiStacks    []cuCPIStack
	simdTime     []simdTimeEntry
	caches       []cacheTracer
	tlbs         []tlbTracer
	drams        []*dramTracer
	cacheBytes   []cacheBytesEntry
}

// cacheBytesEntry pairs a cache with the level it sits at, so one aggregation can
// report L1 and L2 separately.
type cacheBytesEntry struct {
	level  int
	tracer *dramTracer
}

// kernelTimeTracer accumulates the busy time of the driver's kernel commands.
// The driver-command task is the source rather than report.go's "LaunchKernelReq"
// req_in tasks: the dispatcher completes those only while holding its own hook on
// the CP domain, so they never end and report 0.
type kernelTimeTracer struct {
	tracing.NopTracer
	busy *tracing.BusyTimeTracer
}

func newKernelTimeTracer() *kernelTimeTracer {
	return &kernelTimeTracer{
		busy: tracing.NewBusyTimeTracer(func(task tracing.TaskStart) bool {
			return task.What == "*driver.LaunchKernelCommand"
		}),
	}
}

func (t *kernelTimeTracer) StartTask(task tracing.TaskStart) {
	t.busy.StartTask(task)
}

func (t *kernelTimeTracer) EndTask(task tracing.TaskEnd) {
	t.busy.EndTask(task)
}

// BusyTime returns the accumulated kernel busy time in picoseconds.
func (t *kernelTimeTracer) BusyTime() timing.VTimeInPicoSec {
	return t.busy.BusyTime()
}

// simdBusyTracer wraps a BusyTimeTracer and counts the "pipeline" tasks it
// accepts: the per-SIMD instruction count (one per VALU instruction accepted).
type simdBusyTracer struct {
	tracing.NopTracer
	tracer *tracing.BusyTimeTracer
	count  syncCounter
}

func newSIMDBusyTracer() *simdBusyTracer {
	return &simdBusyTracer{
		tracer: tracing.NewBusyTimeTracer(func(task tracing.TaskStart) bool {
			return task.Kind == "pipeline"
		}),
	}
}

func (t *simdBusyTracer) StartTask(task tracing.TaskStart) {
	if task.Kind == "pipeline" {
		t.count.Add(1)
	}
	t.tracer.StartTask(task)
}

func (t *simdBusyTracer) EndTask(task tracing.TaskEnd) {
	t.tracer.EndTask(task)
}

// instCountTracer counts retired instructions per CU, mirroring the runner's
// instTracer minus the stopper (insttracer.go:37-62).
type instCountTracer struct {
	tracing.NopTracer
	count     syncCounter
	inflight  map[uint64]tracing.TaskStart
	inflightM sync.Mutex

	// stream is the live-stream hook, nil unless a sink is installed. Checked
	// rather than called unconditionally because this is the per-retired-
	// instruction path and a native run must pay nothing for it.
	stream func()
}

func newInstCountTracer(stream func()) *instCountTracer {
	return &instCountTracer{inflight: make(map[uint64]tracing.TaskStart), stream: stream}
}

func (t *instCountTracer) StartTask(task tracing.TaskStart) {
	if task.Kind != "inst" {
		return
	}
	t.inflightM.Lock()
	t.inflight[task.ID] = task
	t.inflightM.Unlock()
}

func (t *instCountTracer) EndTask(task tracing.TaskEnd) {
	t.inflightM.Lock()
	_, found := t.inflight[task.ID]
	if found {
		delete(t.inflight, task.ID)
	}
	t.inflightM.Unlock()
	if !found {
		return
	}
	t.count.Add(1)
	// Per retired INSTRUCTION, not per EndTask: this tracer is registered on the
	// compute unit, so EndTask also fires for wavefronts and milestones.
	//
	// Outside the lock on purpose. offer can marshal a body, and marshalling
	// under this non-reentrant mutex deadlocks.
	if t.stream != nil {
		t.stream()
	}
}

// waveCountTracer counts wavefront tasks started per CU.
type waveCountTracer struct {
	tracing.NopTracer
	count syncCounter
}

func (t *waveCountTracer) StartTask(task tracing.TaskStart) {
	if task.Kind == "wavefront" {
		t.count.Add(1)
	}
}

// dramTracer tracks read/write transactions and sizes, mirroring
// amd/samples/runner/dramtracer.go minus the data recorder. It differs from
// upstream in two places: the write byte count honours DirtyMask, and the type
// switch accepts a pointer to a request as well as a value.
type dramTracer struct {
	tracing.NopTracer
	mu            sync.Mutex
	inflightTasks map[uint64]tracing.TaskStart
	readCount     int
	writeCount    int
	readSize      uint64
	writeSize     uint64
}

func newDramTracer() *dramTracer {
	return &dramTracer{inflightTasks: make(map[uint64]tracing.TaskStart)}
}

func (t *dramTracer) StartTask(task tracing.TaskStart) {
	if task.Kind != "req_in" {
		return
	}
	t.mu.Lock()
	t.inflightTasks[task.ID] = task
	t.mu.Unlock()
}

func (t *dramTracer) EndTask(task tracing.TaskEnd) {
	t.mu.Lock()
	originalTask, ok := t.inflightTasks[task.ID]
	if !ok {
		t.mu.Unlock()
		return
	}
	delete(t.inflightTasks, task.ID)

	// A request reaches a tracer as whatever the sender put in the message, and
	// tracing.TraceReqReceive stores that as an `any`, so the dynamic type is the
	// sender's choice. Producers differ: the vector coalescer allocates &ReadReq /
	// &WriteReq (mgpusim/amd/timing/cu/defaultcoalescer.go:139,158) while other
	// forms arrive as values. A case that does not match is a metric that quietly
	// stops counting.
	switch req := originalTask.Detail.(type) {
	case memprotocol.ReadReq:
		t.readCount++
		t.readSize += req.AccessByteSize
	case *memprotocol.ReadReq:
		if req != nil {
			t.readCount++
			t.readSize += req.AccessByteSize
		}
	case memprotocol.WriteReq:
		t.writeCount++
		t.writeSize += dirtyBytes(req)
	case *memprotocol.WriteReq:
		if req != nil {
			t.writeCount++
			t.writeSize += dirtyBytes(*req)
		}
	}
	t.mu.Unlock()
}

// dirtyBytes reports how many bytes a WriteReq actually writes, which is not
// len(req.Data): a WriteReq carries a whole cache line's buffer and DirtyMask
// says which bytes are the caller's, which is how a partial-line store avoids a
// needless rewrite of the rest of the line. The mask is per byte and the same
// length as Data (writethroughcache/intake.go:103 builds that when it is
// absent); a nil mask means every byte is written.
//
// Charging len(Data) instead counted bytes nobody wrote: matmul-naive at N=64
// stores four half-line segments per warp, each arriving as a 64-byte buffer
// with 32 bytes masked off, so L1 and L2 reported 32,768 bytes for 16,384 bytes
// of stores. DRAM was already right at 16,384, because L2 merges the halves
// before writing the line back.
func dirtyBytes(req memprotocol.WriteReq) uint64 {
	if req.DirtyMask == nil {
		return uint64(len(req.Data))
	}
	// A mask longer than the data is malformed: the memory controller reads the mask
	// against the buffer it was handed
	// (idealmemcontroller/memmiddleware.go:188), so an entry past the end of Data
	// has no byte to apply to.
	written := 0
	for i, dirty := range req.DirtyMask {
		if i >= len(req.Data) {
			break
		}
		if dirty {
			written++
		}
	}
	return uint64(written)
}

// syncCounter is a tiny atomic counter.
type syncCounter struct {
	mu sync.Mutex
	v  uint64
}

func (c *syncCounter) Add(n uint64) {
	c.mu.Lock()
	c.v += n
	c.mu.Unlock()
}

func (c *syncCounter) Load() uint64 {
	c.mu.Lock()
	v := c.v
	c.mu.Unlock()
	return v
}

// isTimingCU reports whether the component is a timing compute unit.
func isTimingCU(comp simulation.Component) bool {
	_, ok := comp.(*cu.Comp)
	return ok
}
