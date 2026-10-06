package harness

import (
	"fmt"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/sarchlab/akita/v5/simulation"
)

// Assert the figures against what the shipped platform actually is.
func TestCatalogReportsTheBuiltPlatform(t *testing.T) {
	h := New(Config{})
	defer h.Drain()

	c := h.Catalog()
	described := describedDevice(t, &c)
	if described.Name != "gcn3generic" {
		t.Errorf("described device name = %q, want gcn3generic", described.Name)
	}
	if described.TargetArch != "gfx803" {
		t.Errorf("target arch = %q, want gfx803", described.TargetArch)
	}
	if described.Label == "" {
		t.Error("device label is empty; the About heading would render nothing")
	}

	assertShippedFigures(t, described)
}

// Every device the build can run is in the body, in registry order, and exactly
// one of them is described.
func TestCatalogListsEveryRegistryDeviceAndDescribesOne(t *testing.T) {
	h := New(Config{})
	defer h.Drain()

	c := h.Catalog()

	want := Devices()
	if len(c.Devices) != len(want) {
		t.Fatalf("catalog lists %d devices, want %d (%v)", len(c.Devices), len(want), deviceNames())
	}

	read := 0
	for i, device := range want {
		got := c.Devices[i]
		if got.Name != device.Name {
			t.Errorf("catalog device %d = %q, want %q (registry order is what the body promises)", i, got.Name, device.Name)
			continue
		}
		if got.Label != device.Label || got.ToolchainID != device.Toolchain || got.TargetArch != device.TargetArch {
			t.Errorf("%s: identity %+v does not match its registry entry %+v", got.Name, got, device)
		}
		// Every listed device, described or not, carries a memory size. A
		// dropdown that showed VRAM for one device and nothing for the next
		// would be the same defect as the figures below.
		if got.VramBytes == 0 {
			t.Errorf("%s: no modelled device memory in the catalog, so the VRAM row would render nothing", got.Name)
		}
		if !got.FiguresRead {
			continue
		}
		read++
		if got.Name != h.DeviceName() {
			t.Errorf("%s has its figures read, but the harness was built for %s", got.Name, h.DeviceName())
		}
	}
	if read != 1 {
		t.Errorf("%d devices have their figures read, want exactly 1 (the built one); every extra one cost a platform", read)
	}
}

// An unrun device is not half-described: its figures are zero AND it says so.
// This is the pair a consumer has to be able to tell apart, since a zero compute
// count renders as "0" and reads as a fact about the device.
func TestCatalogGivesAListedOnlyDeviceNoFigures(t *testing.T) {
	c, err := CatalogFor("gcn3generic", nil)
	if err != nil {
		t.Fatalf("CatalogFor(gcn3generic): %v", err)
	}

	for _, device := range c.Devices {
		if device.FiguresRead {
			continue
		}
		if device.ComputeUnits != 0 || device.SimdCount != 0 || device.LdsBytes != 0 || device.ClockHz != 0 {
			t.Errorf("%s is listed but not described, and carries figures %+v; a reader cannot tell them from a measurement", device.Name, device)
		}
		if device.L1vBytes != 0 || device.L2Bytes != 0 || device.L1vBytesUnread || device.L2BytesUnread {
			t.Errorf("%s is listed but not described, and carries cache figures %+v", device.Name, device)
		}
	}
}

// Each entry is asserted against its own registry entry rather than one constant
// for the lot, so either device drifting is still caught.
func TestCatalogReportsTheModelledDeviceMemory(t *testing.T) {
	c, err := CatalogFor("", nil)
	if err != nil {
		t.Fatalf("CatalogFor(%q): %v", "", err)
	}

	for _, device := range c.Devices {
		entry, err := LookupDevice(device.Name)
		if err != nil {
			t.Fatalf("the catalog lists %q, which the registry does not have: %v", device.Name, err)
		}
		if device.VramBytes != entry.MemoryBytes {
			t.Errorf("%s modelled device memory = %d bytes, want its registry entry's %d",
				device.Name, device.VramBytes, entry.MemoryBytes)
		}
	}

	// Spelled out rather than derived from the registry: these two figures are a
	// deliberate choice, not the cards' real capacities.
	if got := mustSelect(t, c, "gcn3generic").VramBytes; got != 16*1024*1024 {
		t.Errorf("gcn3generic modelled device memory = %d bytes, want 16 MiB", got)
	}
	if got := mustSelect(t, c, "cdna3generic").VramBytes; got != 32*1024*1024 {
		t.Errorf("cdna3generic modelled device memory = %d bytes, want 32 MiB", got)
	}
}

// The boundary is the modelled device memory to the byte. Allocating exactly that
// must succeed (which is what makes the boundary the figure rather than something
// below it, e.g. page rounding) and the next byte must panic (which is what makes
// the figure a limit rather than a comment).
func TestDeviceMemoryIsEnforcedByTheAllocator(t *testing.T) {
	h := New(Config{Device: Device{Name: "gcn3generic"}})
	defer h.Drain()

	built := h.Catalog()
	limit := mustSelect(t, &built, "gcn3generic").VramBytes
	if limit == 0 {
		t.Fatal("the catalog reports no device memory, so there is no limit to cross")
	}

	// The whole of it, in one allocation. Nothing here touches the memory it
	// returns -- the backing store allocates storage units on write -- so this
	// costs the page list and not a gigabyte.
	ptr := h.Malloc(int(limit))
	if ptr == 0 {
		t.Fatalf("Malloc(%d) returned a null device pointer, so the limit is below the figure the catalog reports", limit)
	}

	recovered := func() (recovered any) {
		defer func() { recovered = recover() }()
		h.Malloc(1)
		return nil
	}()

	if recovered == nil {
		t.Fatalf("Malloc(1) succeeded after %d bytes were already allocated, so the device memory is not a limit", limit)
	}
	if msg := fmt.Sprint(recovered); !strings.Contains(strings.ToLower(msg), "memory") {
		t.Errorf("crossing the device memory limit panicked with %q, which does not say what ran out; "+
			"a learner who hits this has to be told it is memory", msg)
	}
}

// Pins the MESSAGE, the half of the boundary the previous test cannot reach: that
// one asserts an allocation is refused, this one that a reader can act on it.
// Every clause is asserted separately because each is a way the message can
// become useless while still containing the word "memory".
func TestCrossingTheDeviceMemoryLimitSaysWhatRanOut(t *testing.T) {
	h := New(Config{Device: Device{Name: "gcn3generic"}})
	defer h.Drain()

	built := h.Catalog()
	limit := mustSelect(t, &built, "gcn3generic").VramBytes
	// Allocate most of it, then ask for more than is left, so the message has to
	// report a remainder rather than a full device.
	held := int(limit) / 2
	ptr := h.Malloc(held)
	if ptr == 0 {
		t.Fatalf("Malloc(%d) returned a null device pointer", held)
	}
	oversized := held + 1

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		h.Malloc(oversized)
	}()

	if recovered == nil {
		t.Fatalf("Malloc(%d) succeeded with %d of %d bytes already held, so there is no "+
			"message to assert on", oversized, held, limit)
	}
	message := fmt.Sprint(recovered)

	for _, clause := range []struct{ what, want string }{
		{"the device", "gcn3generic"},
		{"the request", fmt.Sprintf("%d bytes were requested", oversized)},
		{"what was already held", formatBytes(uint64(held))},
		// The limit, not the remainder: a reader who is told what is left still
		// cannot tell whether they are 1 byte over or 512 MiB over, because the
		// number that overflowed was not their allocation.
		{"the limit", formatBytes(limit)},
		{"that this is device memory", "ran out of device memory"},
	} {
		if !strings.Contains(message, clause.want) {
			t.Errorf("the out-of-memory message does not name %s:\n  got  %s\n  want it to contain %q",
				clause.what, message, clause.want)
		}
	}

	if !strings.HasPrefix(message, "harness: ") {
		t.Errorf("the out-of-memory message is not harness-prefixed: %q", message)
	}

	// The refusal must not have been recorded as an allocation. A ledger holding
	// a pointer the driver never returned is what makes the live meter read high
	// for the rest of the run.
	if used := h.usedDeviceMemory(); used != uint64(held) {
		t.Errorf("after a refused %d-byte request the ledger holds %s, want exactly the %s "+
			"that was allocated: a failed Malloc left state behind",
			oversized, formatBytes(used), formatBytes(uint64(held)))
	}
}

// Guards the recover in Malloc: a panic it cannot explain must reach the reader as
// itself rather than being relabelled as device memory exhaustion.
func TestAPanicThatIsNotAnAllocationIsNotRewritten(t *testing.T) {
	h := New(Config{Device: Device{Name: "gcn3generic"}})
	defer h.Drain()

	// Rejected by this package's own guard before the driver is reached, so it stands
	// in for a driver failure that is not about memory.
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		h.Malloc(0)
	}()

	if recovered == nil {
		t.Fatal("Malloc(0) succeeded; the size guard is not there")
	}
	if message := fmt.Sprint(recovered); strings.Contains(message, "does not fit") {
		t.Errorf("a zero-size request was restated as device memory exhaustion: %q", message)
	}
}

// mustSelect is one catalog entry by name, failing the test rather than returning
// a zero value.
func mustSelect(t *testing.T, c *Catalog, name string) CatalogDevice {
	t.Helper()

	for _, device := range c.Devices {
		if device.Name == name {
			return device
		}
	}
	t.Fatalf("the catalog does not list %q: %+v", name, c.Devices)
	return CatalogDevice{}
}

// describedDevice is the one entry with its figures read, and fails the test
// rather than returning a zero value if the body does not have exactly one.
func describedDevice(t *testing.T, c *Catalog) CatalogDevice {
	t.Helper()

	var found *CatalogDevice
	for i := range c.Devices {
		if c.Devices[i].FiguresRead {
			if found != nil {
				t.Fatalf("catalog describes both %s and %s", found.Name, c.Devices[i].Name)
			}
			found = &c.Devices[i]
		}
	}
	if found == nil {
		t.Fatal("catalog describes no device, so every figure in it is zero")
	}
	return *found
}

// assertShippedFigures asserts the figures of the r9nano against the builders that
// set them. Shared by the two callers, which differ only in whether they hold a
// Harness or a CatalogFor body.
func assertShippedFigures(t *testing.T, d CatalogDevice) {
	t.Helper()

	if !d.FiguresRead {
		t.Fatal("shipped figures asserted for a device whose figures were never read")
	}

	// 1 GHz: the r9nano builder's freq, third_party/mgpusim/amd/samples/
	// runner/timingconfig/r9nano/builder.go:79.
	if d.ClockHz != 1_000_000_000 {
		t.Errorf("clock = %d Hz, want 1000000000", d.ClockHz)
	}
	// 4 SIMD units per CU: cu/cubuilder.go:16 defaultSpec.SIMDCount.
	if d.SimdCount != 4 {
		t.Errorf("simd count = %d, want 4", d.SimdCount)
	}
	// 64 KiB of LDS per CU: cu/cubuilder.go:20 defaultSpec.LDSBytes. This is not
	// the L1, so both are asserted separately here.
	if d.LdsBytes != 64*1024 {
		t.Errorf("lds bytes = %d, want %d", d.LdsBytes, 64*1024)
	}
	// 16 KiB of L1 data cache per CU: shaderarray/builder.go:620.
	if d.L1vBytes != 16*1024 {
		t.Errorf("l1v bytes = %d, want %d", d.L1vBytes, 16*1024)
	}
	// 2 MiB of L2 across 16 banks: r9nano/builder.go:82, :474.
	if d.L2Bytes != 2*1024*1024 {
		t.Errorf("l2 bytes = %d, want %d", d.L2Bytes, 2*1024*1024)
	}
	// 4 CUs per SA x 16 SAs: r9nano/builder.go:80-81.
	if d.ComputeUnits != 64 {
		t.Errorf("compute units = %d, want 64", d.ComputeUnits)
	}

	// Every figure was read, so neither Unread flag is set: a consumer must be able to
	// tell that it is allowed to render all three cache figures.
	if d.L1vBytesUnread {
		t.Error("l1v bytes reported unread on the shipped device, whose L1 is a " +
			"writethroughcache.Comp")
	}
	if d.L2BytesUnread {
		t.Error("l2 bytes reported unread on the shipped device, whose L2 is a " +
			"writeback.Comp")
	}
}

func TestCatalogForReportsTheBuiltPlatform(t *testing.T) {
	c, err := CatalogFor("gcn3generic", nil)
	if err != nil {
		t.Fatalf("CatalogFor(gcn3generic): %v", err)
	}
	assertShippedFigures(t, describedDevice(t, c))
}

// The second device is selectable, so the catalog has to be able to describe it by
// name rather than on every read (it costs a 304-CU platform build).
func TestCatalogForDescribesTheSecondDevice(t *testing.T) {
	if len(Devices()) < 2 {
		t.Skip("only one device ships; there is no second one to describe")
	}

	c, err := CatalogFor("cdna3generic", nil)
	if err != nil {
		t.Fatalf("CatalogFor(cdna3generic): %v", err)
	}

	d := describedDevice(t, c)
	if d.Name != "cdna3generic" {
		t.Fatalf("described device = %q, want cdna3generic", d.Name)
	}
	if d.TargetArch != "gfx942" {
		t.Errorf("target arch = %q, want gfx942", d.TargetArch)
	}
	// 2 CUs per SA x 152 SAs: mi300x/builder.go:43-55.
	if d.ComputeUnits != 304 {
		t.Errorf("compute units = %d, want 304", d.ComputeUnits)
	}
	// 4 MiB of L2 across its banks: mi300x/builder.go:127, :606-646. This is the
	// figure that would catch a described device rendered with another's numbers.
	if d.L2Bytes != 4*1024*1024 {
		t.Errorf("l2 bytes = %d, want %d", d.L2Bytes, 4*1024*1024)
	}
	// 32 KiB of L1 data cache per CU: mi300x/builder.go:592, against the
	// r9nano's 16 KiB.
	if d.L1vBytes != 32*1024 {
		t.Errorf("l1v bytes = %d, want %d", d.L1vBytes, 32*1024)
	}
	if d.L1vBytesUnread || d.L2BytesUnread {
		t.Error("a cache size on the second device reported unread, though both are built caches")
	}
}

// An empty device name means the default device, the same contract New has.
func TestCatalogForEmptyNameIsTheDefaultDevice(t *testing.T) {
	got, err := CatalogFor("", nil)
	if err != nil {
		t.Fatalf("CatalogFor(%q): %v", "", err)
	}

	want, err := CatalogFor(DefaultDevice().Name, nil)
	if err != nil {
		t.Fatalf("CatalogFor(%q): %v", DefaultDevice().Name, err)
	}

	if len(got.Devices) != len(want.Devices) || len(got.Devices) != len(Devices()) {
		t.Fatalf("CatalogFor(%q) lists %d devices and the default lists %d, want %d each",
			"", len(got.Devices), len(want.Devices), len(Devices()))
	}
	for i := range got.Devices {
		// DeepEqual, not !=: CatalogDevice carries MemLevels, a []string, so a
		// struct containing a slice is not comparable with == at all.
		if !reflect.DeepEqual(got.Devices[i], want.Devices[i]) {
			t.Errorf("CatalogFor(%q) device %d = %+v, want the default device's %+v", "", i, got.Devices[i], want.Devices[i])
		}
	}
	if got.DefaultDevice != want.DefaultDevice {
		t.Errorf("default device = %q, want %q",
			got.DefaultDevice, want.DefaultDevice)
	}
}

func TestCatalogDefaultDeviceIsOneItLists(t *testing.T) {
	h := New(Config{})
	defer h.Drain()

	c := h.Catalog()
	if c.DefaultDevice == "" {
		t.Fatal("catalog has no default device; the browser select would start empty")
	}
	found := false
	for _, d := range c.Devices {
		if d.Name == c.DefaultDevice {
			found = true
		}
	}
	if !found {
		t.Errorf("default device %q is not in the catalog's own device list", c.DefaultDevice)
	}
}

// Close has to be safe to call twice, and safe on a harness that never started a
// driver goroutine: Driver.Terminate is a send on an unbuffered channel that
// runAsync receives once before returning (driver.go:73-94).
//
// Each case runs on its own goroutine with a timeout, so the failure mode being
// tested for is a legible failure instead of a hung test binary. Only the built
// harness is drained, because Drain reaches through the driver's command queue,
// which a field-by-field harness does not have.
func TestCloseIsIdempotentAndSafeWithoutADriver(t *testing.T) {
	cases := []struct {
		name  string
		h     *Harness
		drain bool
	}{
		{
			// The shipped path: a real harness, drained then closed twice. The
			// drain is what CatalogFor does and Close does not, and it has to
			// come first -- draining a closed harness now panics rather than
			// waiting on a goroutine that is gone.
			name:  "twice on a built harness",
			h:     New(Config{}),
			drain: true,
		},
		{
			// A field-by-field harness, as the render tests build. Its driver
			// goroutine does not exist, so there is nothing to stop and the
			// only thing Terminate could do is block.
			name: "on a harness with no driver",
			h:    &Harness{},
		},
		{
			name: "on a nil harness",
			h:    nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan struct{})
			go func() {
				defer close(done)
				if tc.drain {
					tc.h.Drain()
				}
				tc.h.Close()
				tc.h.Close()
			}()

			select {
			case <-done:
			case <-time.After(30 * time.Second):
				t.Fatal("Close did not return; a second Driver.Terminate blocks " +
					"because no goroutine is left to receive it")
			}
		})
	}
}

// Drain after Close must panic, not merely return: the driver's enqueueSignal
// (api.go:120) has only one receiver, the goroutine Close already stopped, so the
// alternative is a hang. The assertion is on the panic value, not the call
// returning.
func TestDrainAfterClosePanics(t *testing.T) {
	h := New(Config{})
	h.Close()

	type result struct {
		recovered any
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			done <- result{recovered: recover()}
		}()
		h.Drain()
	}()

	select {
	case got := <-done:
		if got.recovered == nil {
			t.Fatal("Drain on a closed harness returned instead of panicking; " +
				"the misuse has to be loud, or a caller that got the order wrong " +
				"blocks forever on the stopped driver's enqueueSignal")
		}
		if msg := fmt.Sprint(got.recovered); !strings.Contains(msg, "closed") {
			t.Errorf("panic %q does not say the harness is closed, so a caller "+
				"reading it cannot tell which of the two orders it got wrong", msg)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Drain on a closed harness blocked instead of panicking; " +
			"api.go:120 sends on a channel only the stopped goroutine received")
	}
}

// Drain on an open harness, however many times, must stay an ordinary call: a
// dozen call sites drain and keep going, and CatalogFor is drain-then-close.
func TestDrainBeforeCloseStaysUsable(t *testing.T) {
	h := New(Config{})
	defer h.Close()

	h.Drain()
	h.Drain()
}

// Asserts goroutines, not bytes: a goroutine count is exact and cannot drift
// between machines, whereas a heap threshold would turn flaky the first time the
// platform builder allocates slightly differently. BenchmarkCatalogForRetention
// regenerates the heap number.
//
// The poll is not slack for its own sake: Driver.Terminate returns as soon as
// runAsync receives, one statement before runAsync itself returns.
func TestCatalogForReleasesItsPlatform(t *testing.T) {
	baseline := runtime.NumGoroutine()

	for i := 0; i < 3; i++ {
		if _, err := CatalogFor("", nil); err != nil {
			t.Fatalf("CatalogFor(%q): %v", "", err)
		}
	}

	deadline := time.Now().Add(30 * time.Second)
	var live int
	for time.Now().Before(deadline) {
		if live = runtime.NumGoroutine(); live <= baseline {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("goroutines after 3 CatalogFor calls = %d, want <= %d (the baseline); "+
		"each call is retaining a platform, so CatalogFor is not releasing it",
		live, baseline)
}

// The byte-level counterpart to TestCatalogForReleasesItsPlatform.
//
//	retainedMiB  heap still live after b.N catalog reads, minus the heap before
//	             them.
//
// Run it with:
//
//	go test ./harness/ -bench CatalogForRetention -run '^$' -benchtime 3x
func BenchmarkCatalogForRetention(b *testing.B) {
	base, goroutinesBefore := settledMemStats()
	b.Logf("baseline: heap %.1f MiB, goroutines %d",
		float64(base.HeapAlloc)/(1<<20), goroutinesBefore)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := CatalogFor("", nil); err != nil {
			b.Fatalf("CatalogFor(%q): %v", "", err)
		}
	}
	b.StopTimer()

	after, goroutinesAfter := settledMemStats()
	b.ReportMetric(float64(int64(after.HeapAlloc)-int64(base.HeapAlloc))/(1<<20), "retainedMiB")
	b.ReportMetric(float64(goroutinesAfter-goroutinesBefore), "retainedGoroutines")
}

// settledMemStats is a post-GC reading taken only once the heap has stopped
// shrinking. Close returns as soon as the driver goroutine receives on
// driverStopped, one statement before that goroutine returns, so a reading taken
// straight afterwards can still see the platform alive.
func settledMemStats() (runtime.MemStats, int) {
	var last runtime.MemStats
	for i := 0; ; i++ {
		runtime.GC()
		time.Sleep(20 * time.Millisecond)
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		if i > 0 && m.HeapAlloc >= last.HeapAlloc {
			return m, runtime.NumGoroutine()
		}
		last = m
	}
}

// An unknown name is an error naming the known set, the same contract
// LookupDevice has. CatalogFor builds a platform to read the figures, and a
// platform for a name MGPUSim does not recognise silently builds an r9nano --
// so the refusal has to happen before the build, not after.
func TestCatalogForRefusesAnUnknownDevice(t *testing.T) {
	_, err := CatalogFor("not-a-device", nil)
	if err == nil {
		t.Fatal("CatalogFor accepted an unknown device name")
	}
	if !strings.Contains(err.Error(), "gcn3generic") {
		t.Errorf("error %q does not name the known devices", err)
	}
}

// A cache component whose concrete type cacheByteSize does not name must report
// that it has no size, not report zero: a zero would render as "L1 data cache: 0 B"
// for a device that has an L1.
//
// notACache implements only Name(), which is the whole simulation.Component
// interface, so no production code has to grow a fake cache type to reach this.
type notACache struct{ name string }

func (c notACache) Name() string { return c.name }

func TestCacheByteSizeReportsAnUnmatchedComponentAsUnread(t *testing.T) {
	comp := notACache{name: "GPU[1].SA[0].L1VCache[0]"}

	size, read := cacheByteSize(comp)
	if read {
		t.Errorf("cacheByteSize(%s) reported a size (%d) for a component type it "+
			"does not know", comp.Name(), size)
	}
}

// describeDevice has to carry the unreadable answer up into the catalog rather than
// leaving a bare zero, for both the per-CU L1 figure and the summed whole-device L2.
func TestDescribeDeviceFlagsAnUnreadableCache(t *testing.T) {
	sim := simulation.MakeBuilder().
		WithoutMonitoring().
		WithoutDataRecording().
		Build()
	sim.RegisterComponent(notACache{name: "GPU[1].SA[0].L1VCache[0]"})
	sim.RegisterComponent(notACache{name: "GPU[1].SA[1].L1VCache[0]"})
	sim.RegisterComponent(notACache{name: "GPU[1].L2Cache[0]"})

	d := describeDevice(sim, Device{Name: "unreadable", Label: "Unreadable"}, 1<<20)

	if !d.L1vBytesUnread {
		t.Error("L1vBytesUnread is false for L1V components of an unknown type, so " +
			"the catalog would render their unreadable size as a zero")
	}
	if !d.L2BytesUnread {
		t.Error("L2BytesUnread is false for an L2 bank of an unknown type, so the " +
			"sum would read as complete")
	}
	if d.L1vBytes != 0 || d.L2Bytes != 0 {
		t.Errorf("figures = l1v %d, l2 %d; want 0 both, because an unread size is "+
			"not a size", d.L1vBytes, d.L2Bytes)
	}
}

// The Dashboard renders its hierarchy from this list, so it must describe what was
// built: CDNA3 has a MALL between L2 and DRAM and the R9 Nano has nothing there.
func TestBuiltMemLevelsMatchesTheDevice(t *testing.T) {
	tests := []struct {
		device string
		want   []string
	}{
		{"gcn3generic", []string{"L1", "L2"}},
		{"cdna3generic", []string{"L1", "L2", "MALL"}},
	}
	for _, tc := range tests {
		device, err := LookupDevice(tc.device)
		if err != nil {
			t.Fatalf("LookupDevice(%q): %v", tc.device, err)
		}
		h := New(Config{Device: device, MaxInst: 1})
		t.Cleanup(h.Close)

		catalog := h.Catalog()
		var described *CatalogDevice
		for i := range catalog.Devices {
			if catalog.Devices[i].FiguresRead {
				described = &catalog.Devices[i]
			}
		}
		if described == nil {
			t.Fatalf("%s: the catalog described no device", tc.device)
		}
		if got := described.MemLevels; !slices.Equal(got, tc.want) {
			t.Errorf("%s memLevels = %v, want %v", tc.device, got, tc.want)
		}
	}
}

// A device whose figures have not been read must not claim a level set: nothing has
// been built, so the honest answer is null, not an empty list that reads as "this
// device has no caches".
func TestUndescribedDeviceHasNoMemLevels(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	for _, d := range h.Catalog().Devices {
		if d.FiguresRead {
			continue
		}
		if d.MemLevels != nil {
			t.Errorf("undescribed device %q reported memLevels %v, want nil", d.Name, d.MemLevels)
		}
	}
}

// The Customize overrides have to reach the platform, not just the catalog row, and
// a figure read back off the built components is the only proof.
func TestCacheOverridesReachTheBuiltPlatform(t *testing.T) {
	const (
		l1v  = 64 * 1024
		l2   = 8 * 1024 * 1024
		mall = 32 * 1024 * 1024
		mem  = 64 * 1024 * 1024
	)
	h := New(Config{
		Device:            mustLookup(t, "cdna3generic"),
		L1VBytes:          l1v,
		L2Bytes:           l2,
		MALLBytes:         mall,
		DeviceMemoryBytes: mem,
		MaxInst:           1,
	})
	t.Cleanup(h.Close)

	described := describedDevice(t, ptrCatalog(h.Catalog()))
	if described.L1vBytes != l1v {
		t.Errorf("L1v = %d, want the requested %d", described.L1vBytes, l1v)
	}
	if described.L2Bytes != l2 {
		t.Errorf("L2 = %d, want the requested %d", described.L2Bytes, l2)
	}
	if described.VramBytes != mem {
		t.Errorf("VRAM = %d, want the requested %d", described.VramBytes, mem)
	}
	// The allocator's limit has to be the same figure, or the panel shows a number
	// the allocator does not honour.
	if h.vramCapacity != mem {
		t.Errorf("allocator limit = %d, want the requested %d", h.vramCapacity, mem)
	}
}

// The builders read a zero as a real size, so an unset override must not be
// forwarded at all.
func TestUnsetOverridesLeaveDeviceDefaults(t *testing.T) {
	h := New(Config{Device: mustLookup(t, "gcn3generic"), MaxInst: 1})
	t.Cleanup(h.Close)

	described := describedDevice(t, ptrCatalog(h.Catalog()))
	if described.L1vBytes == 0 {
		t.Error("L1v = 0 with no override; the device default should stand")
	}
	if described.L2Bytes == 0 {
		t.Error("L2 = 0 with no override; the device default should stand")
	}
}

func ptrCatalog(c Catalog) *Catalog { return &c }

func mustLookup(t *testing.T, name string) Device {
	t.Helper()
	d, err := LookupDevice(name)
	if err != nil {
		t.Fatalf("LookupDevice(%q): %v", name, err)
	}
	return d
}

// A too-small L2 does not always fail cleanly: 1 KiB panics inside MGPUSim's
// driver and 4 KiB returns the wrong answer, which a reader would take for a
// measurement.
func TestCheckSizeOverrides(t *testing.T) {
	t.Parallel()

	// All zero: every field means "device default", which is never a refusal.
	if err := ValidateSizeOverrides("cdna3generic", 0, 0, 0, 0); err != nil {
		t.Errorf("all-defaults refused: %v", err)
	}
	// At and above each floor, accepted.
	for _, sizes := range [][4]uint64{
		{MinL1VBytes, MinL2Bytes, MinMALLBytes, MinDeviceMemoryBytes},
		{16 * 1024, 2 * 1024 * 1024, 256 * 1024 * 1024, 64 * 1024 * 1024},
	} {
		if err := ValidateSizeOverrides("cdna3generic",
			sizes[0], sizes[1], sizes[2], sizes[3]); err != nil {
			t.Errorf("%v refused: %v", sizes, err)
		}
	}
	// One byte under each floor is refused, and the message names the field.
	for _, tc := range []struct {
		name  string
		sizes [4]uint64
		want  string
	}{
		{"l1v", [4]uint64{MinL1VBytes - 1, 0, 0, 0}, "L1 data cache"},
		{"l2", [4]uint64{0, MinL2Bytes - 1, 0, 0}, "L2 cache"},
		{"mall", [4]uint64{0, 0, MinMALLBytes - 1, 0}, "MALL"},
		{"memory", [4]uint64{0, 0, 0, MinDeviceMemoryBytes - 1}, "device memory"},
	} {
		err := ValidateSizeOverrides("cdna3generic",
			tc.sizes[0], tc.sizes[1], tc.sizes[2], tc.sizes[3])
		if err == nil {
			t.Errorf("%s: a size under the floor was accepted", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q does not name %q", tc.name, err, tc.want)
		}
	}
}

// A MALL size on a device with no MALL is ignored, not refused: the builders ignore
// it there, so refusing it would disagree with the browser's copy of this check.
func TestCheckSizeOverridesIgnoresMALLOnADeviceWithout(t *testing.T) {
	t.Parallel()

	if err := ValidateSizeOverrides("gcn3generic", 0, 0, 1, 0); err != nil {
		t.Errorf("a MALL size on the gcn3generic was refused: %v", err)
	}
	// The same value on the device that HAS one is still under the floor.
	if err := ValidateSizeOverrides("cdna3generic", 0, 0, 1, 0); err == nil {
		t.Error("a 1-byte MALL was accepted on the cdna3generic")
	}
}

// The registry flag and the catalog's derived level list have to agree: validation
// reads the flag and the Dashboard renders the list.
func TestRegistryMALLFlagMatchesTheBuiltPlatform(t *testing.T) {
	for _, device := range Devices() {
		h := New(Config{Device: device, MaxInst: 1})
		described := describedDevice(t, ptrCatalog(h.Catalog()))
		derived := slices.Contains(described.MemLevels, "MALL")
		if derived != device.HasMALL {
			t.Errorf("%s: registry HasMALL=%v but the built platform reports memLevels %v",
				device.Name, device.HasMALL, described.MemLevels)
		}
		h.Close()
	}
}

// A device with no MALL must report zero AND say it has none, or the two are
// indistinguishable.
func TestCatalogReportsTheMALLSize(t *testing.T) {
	for _, tc := range []struct {
		device   string
		wantMALL uint64
	}{
		{"gcn3generic", 0}, // GCN3 has no MALL
		{"cdna3generic", 256 * 1024 * 1024},
	} {
		h := New(Config{Device: mustLookup(t, tc.device), MaxInst: 1})
		described := describedDevice(t, ptrCatalog(h.Catalog()))
		hasMALL := slices.Contains(described.MemLevels, "MALL")
		if hasMALL != (tc.wantMALL != 0) {
			t.Errorf("%s: memLevels %v disagrees with mallBytes %d",
				tc.device, described.MemLevels, described.MallBytes)
		}
		if described.MallBytes != tc.wantMALL {
			t.Errorf("%s mallBytes = %d, want %d", tc.device, described.MallBytes, tc.wantMALL)
		}
		if described.MallBytesUnread {
			t.Errorf("%s mallBytesUnread set on a cache type this reads", tc.device)
		}
		h.Close()
	}
}
