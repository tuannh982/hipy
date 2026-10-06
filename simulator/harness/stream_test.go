package harness

import (
	"encoding/json"
	"testing"
	"time"
)

// launches is how many times the fixture kernel is enqueued before the single
// drain that runs them all.
//
// The shipped uniform fixtures are tiny -- vectoradd retires 464 instructions --
// so one launch would produce a single sample and cannot show occupancy changing.
// The examples the browser runs are 1500x larger than this.
const launches = 24

// collect enqueues launches copies of one fixture, drains them with the sink
// installed, and returns every sample in order.
//
// A sink is a package variable, so this is the only way to drive the stream
// natively. The browser can only see a sample arrive; here the test holds every
// one, so a wrong field is a number in a failure message.
func collect(t *testing.T, id string) streamRun {
	t.Helper()

	var samples []Metrics
	MetricsSink = func(payload []byte) {
		var sample Metrics
		if err := json.Unmarshal(payload, &sample); err != nil {
			t.Errorf("live payload is not a Metrics: %v", err)
			return
		}
		samples = append(samples, sample)
	}
	t.Cleanup(func() { MetricsSink = nil })

	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, id)
	run := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 20_000_000})
	recipe := fixture.UniformLaunch
	started := time.Now()
	for i := 1; i < launches; i++ {
		run.h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
			KernelArgs{Pointers: run.pointers, Uint32s: recipe.U32Args})
	}
	run.h.Drain()
	// The same final sample wasmexec's drain export takes: without it this
	// helper's last sample trails the finished collectors by whatever the engine
	// flushed on the way out.
	run.h.EmitFinalSample()
	return streamRun{harness: run.h, samples: samples, elapsed: time.Since(started)}
}

// streamRun is what one driven run leaves behind: the harness so a caller can read
// the finished collectors, the samples as they arrived, and the drain's duration.
type streamRun struct {
	harness *Harness
	samples []Metrics
	elapsed time.Duration
}

// The end-to-end check that the stream fires at all and its figures are the run's.
func TestTheLiveStreamReportsTheRunItIsWatching(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	run := collect(t, primaryFixture(t, loadManifest(t)).ID)
	samples, elapsed := run.samples, run.elapsed
	if len(samples) == 0 {
		t.Fatal("the live stream produced no samples for a fixture that retires instructions: " +
			"the flush trigger is not firing. Check flushStride against the fixture's " +
			"instruction count -- a stride above it means this kernel can never report.")
	}

	// Monotonic: a reader differencing two samples would otherwise compute a
	// negative rate.
	for i := 1; i < len(samples); i++ {
		before, after := samples[i-1], samples[i]
		if after.SimTimePs < before.SimTimePs {
			t.Errorf("sample %d went backwards in simulated time: %d then %d",
				i, before.SimTimePs, after.SimTimePs)
		}
		if after.DRAMReadBytes < before.DRAMReadBytes || after.DRAMWriteBytes < before.DRAMWriteBytes {
			t.Errorf("sample %d's DRAM totals shrank: read %d then %d, write %d then %d",
				i, before.DRAMReadBytes, after.DRAMReadBytes, before.DRAMWriteBytes, after.DRAMWriteBytes)
		}
	}

	last := samples[len(samples)-1]
	if last.SimTimePs <= 0 {
		t.Errorf("the engine clock never advanced: simTimePs = %d", last.SimTimePs)
	}
	if last.Instructions == 0 {
		t.Errorf("a sample reports 0 retired instructions over %d waves; the "+
			"instruction tracer is not reaching the stream", last.Waves)
	}
	if last.Waves == 0 {
		t.Error("a sample reports 0 wavefronts for a run that launched one")
	}
	if last.TotalCUs == 0 || last.TotalSIMDs == 0 {
		t.Errorf("the sample cannot see the device's lanes: %d CUs, %d SIMDs", last.TotalCUs, last.TotalSIMDs)
	}
	if last.TotalSIMDs < last.TotalCUs {
		t.Errorf("%d SIMD lanes across %d compute units: a CU with no lane cannot be idle",
			last.TotalSIMDs, last.TotalCUs)
	}
	if last.VRAMCapacityBytes == 0 {
		t.Error("the sample reports a device with no memory")
	}
	// Host allocations are the host's own ledger, so it can only be a subset of
	// what the device has.
	if last.VRAMUsedBytes > last.VRAMCapacityBytes {
		t.Errorf("the sample reports %d bytes allocated on a device with %d",
			last.VRAMUsedBytes, last.VRAMCapacityBytes)
	}
	if last.DRAMReadBytes == 0 && last.DRAMWriteBytes == 0 {
		t.Error("no DRAM traffic at all, on a fixture that reads and writes memory")
	}
	// The stream must repeat without flooding. The count is checked against the
	// run's own duration rather than a constant: a 450ms drain cannot produce five
	// samples at a 40ms floor.
	if len(samples) < 2 {
		t.Fatalf("the stream produced %d samples over %d launches; it fires once "+
			"and then stops, which is not a stream", len(samples), launches)
	}
	ceiling := int(elapsed/flushInterval) + 2
	if len(samples) > ceiling {
		t.Errorf("the stream produced %d samples in %s, more than the %d a %s "+
			"interval floor allows: it is flooding",
			len(samples), elapsed, ceiling, flushInterval)
	}
	// Each sample must be strictly later than the last, or the panel's rates are
	// differences of equal numbers.
	for i := 1; i < len(samples); i++ {
		if samples[i].Instructions <= samples[i-1].Instructions {
			t.Errorf("sample %d reports %d instructions, not more than the %d in "+
				"sample %d: samples are not advancing",
				i, samples[i].Instructions, samples[i-1].Instructions, i-1)
		}
	}
	if len(last.CacheHitRate) == 0 {
		t.Error("no cache level reported a hit rate on a fixture that misses caches")
	}
}

// The one assertion the finished telemetry body cannot make. "Active" means a SIMD
// lane is holding or issuing a wavefront, a property of the run at an instant; after
// Drain every lane is idle by construction and the finished metrics can only report
// the cumulative count.
func TestALiveSampleReportsSomeLaneActive(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	samples := collect(t, primaryFixture(t, loadManifest(t)).ID).samples
	peakCUs, peakSIMDs := 0, 0
	for _, sample := range samples {
		if sample.ActiveCUs > peakCUs {
			peakCUs = sample.ActiveCUs
		}
		if sample.ActiveSIMDs > peakSIMDs {
			peakSIMDs = sample.ActiveSIMDs
		}
	}
	if peakSIMDs == 0 {
		t.Errorf("every sample reported 0 of %d lanes active, across %d samples of a "+
			"running kernel: SIMDUnit.IsIdle is not reporting occupancy",
			samples[len(samples)-1].TotalSIMDs, len(samples))
	}
	if peakCUs == 0 {
		t.Errorf("every sample reported 0 of %d compute units active", samples[len(samples)-1].TotalCUs)
	}
	// A lane cannot be active without its compute unit being active.
	if peakSIMDs > 0 && peakCUs == 0 {
		t.Error("lanes are active while no compute unit is")
	}
}

// The copies and memsets ahead of a launch are themselves DRAM writes and all
// complete before the first instruction, so the absolute totals open with the whole
// setup cost counted. The since-launch pair is what the panel plots, and this asserts
// it opens at zero.
func TestALiveSampleMeasuresTheKernelNotTheSetup(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	run := collect(t, primaryFixture(t, loadManifest(t)).ID)
	samples := run.samples
	if len(samples) == 0 {
		t.Fatal("no live samples; the stream is not firing")
	}

	// The two pairs stay coherent: since-launch can never exceed the absolute.
	for i, sample := range samples {
		if sample.DRAMReadSinceLaunchBytes > sample.DRAMReadBytes {
			t.Errorf("sample %d reports %d bytes read since launch against %d absolute",
				i, sample.DRAMReadSinceLaunchBytes, sample.DRAMReadBytes)
		}
		if sample.DRAMWriteSinceLaunchBytes > sample.DRAMWriteBytes {
			t.Errorf("sample %d reports %d bytes written since launch against %d absolute",
				i, sample.DRAMWriteSinceLaunchBytes, sample.DRAMWriteBytes)
		}
	}

	// The setup is EXCLUDED, which is the property and not merely a smaller number.
	first := samples[0]
	excluded := first.DRAMWriteBytes - first.DRAMWriteSinceLaunchBytes
	if excluded == 0 {
		t.Error("the first sample's absolute and since-launch write totals are equal, so " +
			"nothing was excluded: the baseline is not being taken at the launch")
	}

	// The kernel's own traffic is what remains, so it must GROW: a baseline that
	// excluded too much would show a flat zero.
	last := samples[len(samples)-1]
	if last.DRAMReadSinceLaunchBytes <= first.DRAMReadSinceLaunchBytes {
		t.Errorf("reads since launch did not grow across the run: %d then %d",
			first.DRAMReadSinceLaunchBytes, last.DRAMReadSinceLaunchBytes)
	}

	// The series ENDS where the finished body says it should.
	collected := run.harness.collectDRAM()
	if last.DRAMReadBytes != collected.readBytes {
		t.Errorf("the last live sample reports %d bytes read, the finished telemetry reports "+
			"%d: the live series and the OTLP body disagree about the same run",
			last.DRAMReadBytes, collected.readBytes)
	}
	if last.DRAMWriteBytes != collected.writeBytes {
		t.Errorf("the last live sample reports %d bytes written, the finished telemetry "+
			"reports %d", last.DRAMWriteBytes, collected.writeBytes)
	}
}

// A kernel whose output fits in L2 leaves its dirty lines in the cache, and they
// reach DRAM only when the host reads the result back -- the copy overlaps a buffer
// the launch marked L2-dirty, so the driver issues CmdFlush before copying
// (mgpusim/amd/driver/memorycopy.go:151). That flush is in flight when the pacing
// stops, so the kernel's writes can arrive after the last paced sample. Nothing
// flushes at Close, and a program that never reads its results back never flushes.
func TestEmitLiveFinalAddsTheSampleTheRunEndedWith(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, primaryFixture(t, manifest).ID)
	h := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 2_000_000}).h
	// runUniformFixtureRun drains on cleanup, so the engine is already idle. Sample
	// by hand rather than through the pacer, which needs a sink.
	before := h.sampleMetrics()
	h.EmitFinalSample()

	// Idempotent while the clock is still: a second drain must not append a
	// duplicate point at the same instant.
	if got := h.sampleMetrics(); got.SimTimePs != before.SimTimePs {
		t.Fatalf("the engine clock moved between two samples of an idle simulation: "+
			"%d then %d", before.SimTimePs, got.SimTimePs)
	}
}

// The shipped fixture's three buffers are 12 KiB and MinL2Bytes is 64 KiB, so it
// can never evict. Each launch here gets its own buffer triple, taking the working
// set to ~288 KiB against a 64 KiB L2, which is what makes eviction happen
// mid-run.
func TestL2WritesBackToDRAMDuringTheRunWhenItIsUnderPressure(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	var samples []Metrics
	MetricsSink = func(payload []byte) {
		var s Metrics
		if err := json.Unmarshal(payload, &s); err != nil {
			t.Errorf("live payload is not a Metrics: %v", err)
			return
		}
		samples = append(samples, s)
	}
	t.Cleanup(func() { MetricsSink = nil })

	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, primaryFixture(t, manifest).ID)
	recipe := fixture.UniformLaunch

	const launches = 24
	workingSet := launches * recipe.PointerArgs * recipe.Elements * 4
	if workingSet <= MinL2Bytes {
		t.Fatalf("this test cannot evict anything: the working set is %d bytes and the "+
			"smallest buildable L2 is %d, so a flat write line would prove nothing",
			workingSet, MinL2Bytes)
	}

	h := New(Config{MaxInst: 200_000_000, L2Bytes: MinL2Bytes})
	t.Cleanup(func() { h.Close() })
	h.LoadCodeObject(codeObject)

	// A distinct triple per launch, so the working set grows past L2 instead of
	// rewriting the same lines, which would be absorbed in place and never evict.
	triples := make([][]uint64, launches)
	for i := range triples {
		triple := make([]uint64, recipe.PointerArgs)
		for j := range triple {
			triple[j] = h.Malloc(recipe.Elements * 4)
		}
		for j := 0; j < recipe.H2DBuffers; j++ {
			values := make([]float32, recipe.Elements)
			for k := range values {
				if j == 0 {
					values[k] = float32(k)
				} else {
					values[k] = float32(2*k + 1)
				}
			}
			h.MemcpyH2D(triple[j], f32Bytes(values))
		}
		triples[i] = triple
	}
	h.Drain()

	for i := range triples {
		h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
			KernelArgs{Pointers: triples[i], Uint32s: recipe.U32Args})
	}
	h.Drain()
	h.EmitFinalSample()

	if len(samples) == 0 {
		t.Fatal("no live samples; the stream is not firing, so nothing can be said about when " +
			"the writeback happened")
	}

	// The H2D setup is banked by the first sample, so growth between two samples is
	// the kernel's traffic and nothing else.
	storesPerLaunch := uint64(recipe.Elements * 4)
	growingSamples := 0
	for i := 1; i < len(samples); i++ {
		before, after := samples[i-1], samples[i]
		grew := after.DRAMWriteSinceLaunchBytes - before.DRAMWriteSinceLaunchBytes
		if grew == 0 {
			continue
		}
		growingSamples++
		t.Logf("sample %d: DRAM writes grew %d bytes since launch", i, grew)
	}
	if growingSamples < 2 {
		t.Errorf("DRAM writes moved in %d samples of %d: the writeback is not tracking the "+
			"run", growingSamples, len(samples))
	}

	// Not the exact total: lines still resident in L2 when the stream ends have
	// legitimately not been written back, so the final figure lands a fraction of a
	// cache line short. What matters is that the bulk had crossed by the
	// second-to-last sample.
	last := samples[len(samples)-1]
	totalStores := uint64(launches) * storesPerLaunch
	if last.DRAMWriteSinceLaunchBytes == 0 {
		t.Fatal("no DRAM writes at all across the whole run, on a working set that " +
			"exceeds L2 by 4x")
	}
	earlier := len(samples) - 1
	if earlier <= 0 {
		t.Skip("the run produced a single sample, so it cannot show when the writeback happened")
	}
	beforeLast := samples[earlier].DRAMWriteSinceLaunchBytes
	if beforeLast*2 < totalStores {
		t.Errorf("only %d of %d bytes of stores had reached DRAM by the second-to-last of "+
			"%d samples: writeback is happening at the drain rather than during the run",
			beforeLast, totalStores, len(samples))
	}
}

// The cost half. Every retired instruction reaches the tracer, so the trigger is on
// the simulator's hottest path; with no sink installed there must be no clock read
// and no flush, only one nil check per instruction.
func TestNoLiveStreamWithoutASinkSoNativeRunsPayNothing(t *testing.T) {
	if MetricsSink != nil {
		t.Fatal("a sink is installed before this test set one; the cleanup is not running")
	}

	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, primaryFixture(t, manifest).ID)
	h := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 2_000_000}).h

	if h.stream != nil {
		t.Error("a harness built with no sink installed a live pacer, so its tracers " +
			"carry a hook that can only do work")
	}
	// Still correct when sampled by hand: the snapshot is a pure read.
	sample := h.sampleMetrics()
	if sample.Instructions == 0 {
		t.Error("sampleMetrics reports 0 instructions on a harness that ran a fixture")
	}
}
