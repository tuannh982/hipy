package harness

import (
	"github.com/sarchlab/akita/v5/mem/cache/writeback"
	"github.com/sarchlab/akita/v5/mem/cache/writethroughcache"
	"github.com/sarchlab/akita/v5/simulation"
	"github.com/sarchlab/mgpusim/v5/amd/timing/cu"
)

// CatalogDevice is one device's identity plus the figures of the timing model the
// simulator built for it. Every numeric field is read off a constructed component
// rather than declared here.
type CatalogDevice struct {
	// The registry entry, passed through. DisabledReason lets the browser render
	// an unrunnable device disabled rather than offer it.
	Name  string `json:"name"`
	Label string `json:"label"`
	// ToolchainID and TargetArch are the pair the browser compiles with; the
	// browser looks the id up in toolchain/toolchains.json, so a disagreement
	// between the two is a build-time failure there.
	ToolchainID    string `json:"toolchainId"`
	TargetArch     string `json:"targetArch"`
	DisabledReason string `json:"disabledReason"`

	// VramBytes is the modelled device memory, and the one figure every entry
	// carries whether or not FiguresRead is set. Both shipped platforms model
	// tens of MiB, against 4 GiB and 192 GiB on the hardware their builders
	// derive from; read it as how much device memory a kernel here can have.
	VramBytes uint64 `json:"vramBytes"`

	// FiguresRead separates a device this catalog was built to describe from one
	// that is only listed; everything below is zero when it is false. Reading a
	// device's figures means building its platform (64 CUs for the r9nano, 304
	// for the mi300x, and the mi300x build alone reaches ~700 MiB of Go heap),
	// so the catalog describes one device and lists the rest.
	FiguresRead bool `json:"figuresRead"`

	// ClockHz is the compute unit's clock (r9nano/builder.go:79).
	ClockHz uint64 `json:"clockHz"`

	// SimdCount is SIMD units per CU, not the wavefront width (64 on GCN3) and
	// not the LDS phase width.
	SimdCount int `json:"simdCount"`

	// LdsBytes is the local data share per CU, unrelated to L1vBytes.
	LdsBytes int `json:"ldsBytes"`

	// L1vBytes is the L1 data cache PER CU, from one built component. Not summed:
	// one is built per CU, so a sum would report the whole L1 under a per-CU
	// heading.
	L1vBytes uint64 `json:"l1vBytes"`

	// L2Bytes is the whole L2, summed across its banks (r9nano/builder.go:474).
	L2Bytes uint64 `json:"l2Bytes"`

	// MallBytes is the whole MALL, CDNA3's Infinity Cache between L2 and DRAM. Zero
	// AND MallBytesUnread on a device with no MALL. The size is the whole
	// explanation for CDNA3's DRAM read figures: at 256 MB it holds any kernel's
	// working set, so DRAM sees almost nothing.
	MallBytes uint64 `json:"mallBytes"`

	// ComputeUnits is how many CUs the platform built.
	ComputeUnits int `json:"computeUnits"`

	// L1vBytesUnread and L2BytesUnread report that the figure beside them is not
	// a measurement: cacheByteSize switches on concrete type, so an unnamed cache
	// flavour yields 0, and these separate that from a real zero.
	L1vBytesUnread  bool `json:"l1vBytesUnread"`
	L2BytesUnread   bool `json:"l2BytesUnread"`
	MallBytesUnread bool `json:"mallBytesUnread"`

	// MemLevels names the cache levels this device actually built, innermost first,
	// and is the schema the Dashboard renders from. Absence means the device does not
	// have the level, which differs from the level having seen no traffic.
	MemLevels []string `json:"memLevels"`
}

// Catalog is every device this build can run, plus the one the playground starts
// on. Exactly one entry has FiguresRead set, and the order is registry order
// sorted by name, so a consumer looking for a device looks it up by name.
type Catalog struct {
	Devices       []CatalogDevice `json:"devices"`
	DefaultDevice string          `json:"defaultDevice"`
}

// Catalog lists every registry device and describes the one this harness was
// built for. It reads h.sim, so CatalogFor builds one for a caller that has none.
func (h *Harness) Catalog() Catalog {
	described, err := LookupDevice(h.deviceName)
	if err != nil {
		// Unreachable: New resolves the name the same way and panics.
		panic("harness: " + err.Error())
	}

	c := Catalog{DefaultDevice: DefaultDevice().Name, Devices: []CatalogDevice{}}
	for _, device := range Devices() {
		if device.Name == described.Name {
			c.Devices = append(c.Devices, describeDevice(h.sim, device, h.vramCapacity))
			continue
		}
		c.Devices = append(c.Devices, listDevice(device, deviceMemoryBytes(device)))
	}
	return c
}

// CatalogFor builds a local harness to read one device's figures, and lists the
// rest. It touches no package-level state, so a caller may use it and then build
// its own harness.
//
// Drain must precede Close: Close stops the driver's goroutine, and
// DrainCommandQueue signals a channel only that goroutine receives, so draining
// afterwards blocks forever. Nothing is enqueued, so the drain is nearly free.
//
// An empty name means the default device, as in New. The name is resolved before
// the build deliberately: timingconfig.Builder defaults to r9nano for a name it
// does not recognise, so building first would report an r9nano's figures under
// the caller's name. Nil sizes means no overrides.
func CatalogFor(deviceName string, sizes *Config) (*Catalog, error) {
	if deviceName == "" {
		deviceName = DefaultDevice().Name
	}
	if _, err := LookupDevice(deviceName); err != nil {
		return nil, err
	}

	cfg := Config{Device: Device{Name: deviceName}}
	if sizes != nil {
		cfg.L1VBytes = sizes.L1VBytes
		cfg.L2Bytes = sizes.L2Bytes
		cfg.MALLBytes = sizes.MALLBytes
		cfg.DeviceMemoryBytes = sizes.DeviceMemoryBytes
	}
	h := New(cfg)
	defer func() {
		h.Drain()
		h.Close()
	}()

	c := h.Catalog()
	return &c, nil
}

// listDevice is what a device the catalog does not describe carries: its
// identity, and the one figure that does not need a platform to read.
//
// vramCapacity is passed rather than read off the registry because a Customize
// override changes it, and this row bounds the allocator.
func listDevice(device Device, vramCapacity uint64) CatalogDevice {
	return CatalogDevice{
		Name:           device.Name,
		Label:          device.Label,
		ToolchainID:    device.Toolchain,
		TargetArch:     device.TargetArch,
		DisabledReason: device.DisabledReason,
		VramBytes:      vramCapacity,
		FiguresRead:    false,
	}
}

// deviceMemoryBytes is the device memory this device's model has, read off the
// registry entry so it is the same number New hands the platform builder.
func deviceMemoryBytes(device Device) uint64 {
	return device.MemoryBytes
}

// describeDevice reads one device's figures off a built platform. The walk
// matches the last dot-separated name segment (metrics.go:152) rather than
// Contains, so "GPU[1].L2ToDRAM" is not mistaken for a DRAM.
func describeDevice(sim *simulation.Simulation, device Device, vramCapacity uint64) CatalogDevice {
	out := listDevice(device, vramCapacity)
	out.FiguresRead = true

	// First-wins, uniformly, so the answer does not depend on registration order.
	// Every CU comes from one spec, so first and last agree. ClockHz is taken
	// rather than summed; a sum would read as a frequency many times too high.
	var haveCU, haveL1v bool
	for _, comp := range sim.Components() {
		name := comp.Name()
		switch {
		case isCUName(name) && isTimingCU(comp):
			out.ComputeUnits++
			if haveCU {
				continue
			}
			haveCU = true
			spec := comp.(*cu.Comp).Spec()
			out.SimdCount = spec.SIMDCount
			out.LdsBytes = spec.LDSBytes
			out.ClockHz = uint64(spec.Freq)
		case lastNameSegmentContains(name, "L1VCache["):
			size, read := cacheByteSize(comp)
			if !read {
				out.L1vBytesUnread = true
				continue
			}
			if haveL1v {
				continue
			}
			haveL1v = true
			out.L1vBytes = size
		case lastNameSegmentContains(name, "L2Cache["):
			size, read := cacheByteSize(comp)
			if !read {
				out.L2BytesUnread = true
				continue
			}
			out.L2Bytes += size
		case lastNameSegmentContains(name, "MALL["):
			size, read := cacheByteSize(comp)
			if !read {
				out.MallBytesUnread = true
				continue
			}
			out.MallBytes += size
		}
	}

	out.MemLevels = builtMemLevels(sim)
	return out
}

// builtMemLevels reports which cache levels the platform actually built, innermost
// first. Read off components rather than the device's name, since the level set
// differs by build.
func builtMemLevels(sim *simulation.Simulation) []string {
	var seen [memLevelCount]bool
	for _, comp := range sim.Components() {
		name := comp.Name()
		switch {
		case lastNameSegmentContains(name, "L1VCache["),
			lastNameSegmentContains(name, "L1SCache"),
			lastNameSegmentContains(name, "L1ICache"):
			seen[memLevelL1] = true
		case lastNameSegmentContains(name, "L2Cache["):
			seen[memLevelL2] = true
		case lastNameSegmentContains(name, "MALL["):
			seen[memLevelMALL] = true
		}
	}
	levels := make([]string, 0, memLevelCount)
	for level := 0; level < memLevelCount; level++ {
		if seen[level] {
			levels = append(levels, memLevelNames[level])
		}
	}
	return levels
}

// cacheByteSize is a built cache component's total byte size, and whether the type
// switch could read it at all. The switch is over concrete types because the write-
// through L1 and write-back L2 have different Spec() return types. The bool is the
// point: a third cache type matches nothing, and answering 0 would look like an
// empty cache.
func cacheByteSize(comp simulation.Component) (uint64, bool) {
	switch c := comp.(type) {
	case *writethroughcache.Comp:
		return c.Spec().TotalByteSize, true
	case *writeback.Comp:
		return c.Spec().TotalByteSize, true
	}
	return 0, false
}
