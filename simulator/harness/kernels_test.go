package harness

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// Dedup and ordering are the contract the panel's index lookup depends on, and
// neither needs a kernel to have moved a byte to be checked.
func TestAKernelInALoopIsOneEntryAndNeverMoves(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	const simTime = uint64(1000)
	h.beginKernelLaunch("reduceBlocks", simTime)
	h.closeKernelLaunch(simTime)
	if got := h.kernelTrafficSnapshot(); len(got) != 1 || got[0].Kernel != "reduceBlocks" {
		t.Fatalf("after one launch: %+v", got)
	}

	// The same kernel again is the same entry, with its launch count raised.
	for range 3 {
		h.beginKernelLaunch("reduceBlocks", simTime)
		h.closeKernelLaunch(simTime)
	}
	got := h.kernelTrafficSnapshot()
	if len(got) != 1 {
		t.Fatalf("%d entries for one kernel in a loop, want 1", len(got))
	}
	if got[0].Launches != 4 {
		t.Errorf("the entry counts %d launches, want 4", got[0].Launches)
	}
	if got[0].FirstSimTimePs != simTime {
		t.Errorf("the window opens at %d, want %d", got[0].FirstSimTimePs, simTime)
	}

	// A second kernel APPENDS, so index 0 still means the first kernel. A panel
	// resolving a series by index would otherwise be re-pointed mid-run.
	h.beginKernelLaunch("reduceFinal", simTime*2)
	h.closeKernelLaunch(simTime * 2)
	got = h.kernelTrafficSnapshot()
	if len(got) != 2 {
		t.Fatalf("%d entries after two distinct kernels, want 2", len(got))
	}
	if got[0].Kernel != "reduceBlocks" || got[1].Kernel != "reduceFinal" {
		t.Errorf("entries are %q then %q, want reduceBlocks then reduceFinal", got[0].Kernel, got[1].Kernel)
	}
	if got[1].FirstSimTimePs != simTime*2 {
		t.Errorf("the second kernel's window opens at %d, want %d", got[1].FirstSimTimePs, simTime*2)
	}
}

// A snapshot is what the panel reads while a run is in flight, so it must not hand
// out the live maps a later launch writes into.
func TestTheKernelSnapshotIsACopy(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	const simTime = uint64(1000)
	h.beginKernelLaunch("k", simTime)
	h.closeKernelLaunch(simTime)

	first := h.kernelTrafficSnapshot()
	h.beginKernelLaunch("k", simTime)
	h.closeKernelLaunch(simTime)

	if first[0].Launches != 1 {
		t.Errorf("the earlier snapshot's launch count changed to %d under the caller", first[0].Launches)
	}
}

// Every launch is counted, whichever way the launch ends.
//
// Two things retire a launch: the next launch supersedes it, and a drain retires the
// last one. Counting only at drains loses every launch the next one superseded, and
// counting only at launch boundaries loses the last one -- so both paths go through
// one function and both have to be exercised. The stream samples this accounting from
// the engine goroutine while a drain retires from the main one, so a run long enough
// to overlap them is the case that must not lose a launch.
func TestEveryLaunchIsCountedHoweverItEnds(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, "vectoradd")
	recipe := fixture.UniformLaunch
	if recipe == nil {
		t.Skip("the vectoradd fixture has no launch recipe")
	}

	// Superseded: launch several, drain once at the end.
	superseded := New(Config{MaxInst: 200_000_000})
	t.Cleanup(superseded.Close)
	superseded.LoadCodeObject(codeObject)
	run := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 50_000_000})
	before := run.h.kernelTrafficSnapshot()[0].Launches
	const supersededCount = 5
	for range supersededCount {
		run.h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
			KernelArgs{Pointers: run.pointers, Uint32s: recipe.U32Args})
	}
	run.h.Drain()
	if got := run.h.kernelTrafficSnapshot()[0].Launches; got != before+supersededCount {
		t.Errorf("superseded launches counted %d, want %d: %d of %d lost",
			got-before, supersededCount, before+supersededCount-got, supersededCount)
	}

	// Drained one at a time: each launch is retired by its own drain.
	perDrain := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 50_000_000}).h
	base := perDrain.kernelTrafficSnapshot()[0].Launches
	const drainedCount = 5
	for range drainedCount {
		perDrain.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
			KernelArgs{Pointers: run.pointers, Uint32s: recipe.U32Args})
		perDrain.Drain()
	}
	if got := perDrain.kernelTrafficSnapshot()[0].Launches; got != base+drainedCount {
		t.Errorf("per-drain launches counted %d, want %d", got-base, drainedCount)
	}
}

// The panel walks the sample's JSON, so the breakdown has to survive the crossing
// and the paths the schema hands it have to resolve against it.
func TestKernelTrafficResolvesTheSchemaPaths(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, "vectoradd")
	recipe := fixture.UniformLaunch
	if recipe == nil {
		t.Skip("the vectoradd fixture has no launch recipe")
	}
	run := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 50_000_000})

	run.h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
		KernelArgs{Pointers: run.pointers, Uint32s: recipe.U32Args})
	run.h.Drain()

	// A real launch must move something, or every kernel series draws flat.
	entries := run.h.kernelTrafficSnapshot()
	if len(entries) != 1 {
		t.Fatalf("%d entries for one launched kernel, want 1", len(entries))
	}
	moved := false
	for level, sample := range entries[0].Levels {
		if sample.ReadBytes > 0 || sample.WriteBytes > 0 {
			moved = true
		}
		_ = level
	}
	if !moved {
		t.Errorf("kernel %q moved nothing at any level: %+v", entries[0].Kernel, entries[0].Levels)
	}

	raw, err := json.Marshal(run.h.sampleMetrics())
	if err != nil {
		t.Fatalf("marshal the sample: %v", err)
	}
	var decoded Metrics
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("the sample does not read back as one: %v", err)
	}
	if len(decoded.KernelTraffic) != 1 {
		t.Fatalf("kernelTraffic did not survive the JSON crossing: %d entries", len(decoded.KernelTraffic))
	}

	schema := run.h.DashboardSchema()
	checked := 0
	for _, chart := range schema.Charts {
		if chart.KernelSeries == nil {
			continue
		}
		for index := range decoded.KernelTraffic {
			for _, template := range []string{chart.KernelSeries.ReadPath, chart.KernelSeries.WritePath} {
				path := strings.Replace(template, "%d", strconv.Itoa(index), 1)
				if !pathResolves(decoded, path) {
					t.Errorf("chart %q path %q resolves to nothing in the sample", chart.ID, path)
				}
				checked++
			}
		}
	}
	if checked == 0 {
		t.Error("no traffic chart declared a per-kernel breakdown, so nothing was checked")
	}
}

// A level this device does not have is absent from a kernel's entry rather than
// present-and-zero, matching what the hierarchy strip does for the device totals.
func TestAKernelHasNoEntryForALevelTheDeviceLacks(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, "vectoradd")
	recipe := fixture.UniformLaunch
	run := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 50_000_000})
	run.h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
		KernelArgs{Pointers: run.pointers, Uint32s: recipe.U32Args})
	run.h.Drain()

	entries := run.h.kernelTrafficSnapshot()
	for _, entry := range entries {
		for level := 0; level < memLevelCount; level++ {
			name := memLevelNames[level]
			_, present := entry.Levels[name]
			if want := run.h.hasMemLevel(level); present != want {
				t.Errorf("kernel %q reports level %s present=%v, but the device has it=%v",
					entry.Kernel, name, present, want)
			}
		}
		if _, present := entry.Levels["DRAM"]; !present {
			t.Errorf("kernel %q has no DRAM entry, and every device has DRAM", entry.Kernel)
		}
	}
}
