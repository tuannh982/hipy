package harness

import (
	"bytes"
	"debug/elf"
	"encoding/binary"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/sarchlab/akita/v5/simulation"
	"github.com/sarchlab/akita/v5/tracing"
	"github.com/sarchlab/mgpusim/v5/amd/driver"
	"github.com/sarchlab/mgpusim/v5/amd/insts"
	"github.com/sarchlab/mgpusim/v5/amd/samples/runner/timingconfig"
)

// Config configures the harness.
type Config struct {
	MaxInst int

	// StopOnMaxInst runs when the MaxInst cutoff is reached. Nil prints a note
	// to stderr and exits 3; tests inject a func that must not os.Exit.
	StopOnMaxInst func()

	// Cache and memory size overrides, in bytes. Zero means "whatever the device
	// builder defaults to".
	//
	// L1VBytes is PER CU, because one L1V is built per CU. L2Bytes is the whole L2
	// across its banks, and MALLBytes is the whole MALL. MALLBytes does nothing on
	// a device with no MALL.
	//
	// DRAMBytes is the range the memory controllers are built to address, which is
	// not the same figure as DeviceMemoryBytes below: a controller range smaller
	// than the allocator limit lets a kernel allocate memory nothing backs, so
	// callers should normally set DeviceMemoryBytes instead.
	L1VBytes  uint64
	L2Bytes   uint64
	MALLBytes uint64
	DRAMBytes uint64

	// DeviceMemoryBytes overrides the device's modelled memory AND the limit the
	// allocator enforces, as one figure: the number on the VRAM gauge is the
	// number a kernel is refused for exceeding.
	DeviceMemoryBytes uint64

	// LDSDrain reads the MGPUSim LDS bank analyzer: the report the LDS tab renders
	// plus the task index the timeline joins spans against. Use
	// ldsanalysis.Drain.
	//
	// A field rather than an import because the analyzer is added by a patch and does
	// not exist in a bare checkout of the pinned commit, and the patch A/B builds this
	// package against an unpatched tree too. Nil means no analyzer is linked.
	LDSDrain LDSDrain

	// Device is the simulated GPU to build. The zero value selects
	// DefaultDevice, so existing callers that never set it are unaffected.
	Device Device
}

// KernelArgs carries kernel parameters in declaration order.
type KernelArgs struct {
	Pointers []uint64
	Uint32s  []uint32
	Floats   []float32
}

// Harness wraps an MGPUSim GPU with a simple command API. Zero values are not
// valid; use New.
//
// The API panics on invalid usage (unknown pointers, missing LoadCodeObject, zero
// block dims, unknown kernel names) with a "harness: " prefixed message.

// The smallest cache the platform can be built with, per knob. akita derives
// numSets = TotalByteSize / (WayAssociativity * blockSize)
// (third_party/akita/mem/cache/writeback/builder.go) and every lookup computes its
// set as hashedAddr % numSets. At 16-way associativity and 64 B lines that is
// 1024 bytes per set per bank, so 1024 x 16 banks = 16 KiB is the smallest L2 that
// leaves one set per bank; below it numSets is 0 and the first lookup divides by
// zero. The floors are several times higher than that, because one set per bank
// conflicts on everything and profiles meaninglessly. No device default (2 MiB and
// 4 MiB L2, 256 MiB MALL) is refused by its own floor.
//
// L1V has its own floor because 4 KiB still computes correctly there, and its
// device defaults are 16 KiB and 32 KiB.
const (
	MinL1VBytes          = 4 * 1024
	MinL2Bytes           = 64 * 1024
	MinMALLBytes         = 64 * 1024
	MinDeviceMemoryBytes = 1024 * 1024
)

// ValidateSizeOverrides refuses sizes the platform cannot be built with, by name.
//
// deviceName decides which knobs apply: the builders ignore a MALL size on a device
// with no MALL, and website/src/lib/deviceOverrides.ts skips the field for the same
// reason. An unknown device name skips nothing; New refuses unknown names right
// after.
//
// Checked before the builders rather than inside them because the builders accept a
// 1-byte cache without complaint and the failure surfaces later as a panic deep in
// the driver, or not at all.
func ValidateSizeOverrides(deviceName string, l1v, l2, mall, memory uint64) error {
	hasMALL := deviceHasMALL(deviceName)
	for _, c := range []struct {
		name string
		got  uint64
		min  uint64
		// Skipped when the field cannot affect the platform at all.
		applicable bool
	}{
		{"L1 data cache", l1v, MinL1VBytes, true},
		{"L2 cache", l2, MinL2Bytes, true},
		{"MALL", mall, MinMALLBytes, hasMALL},
		{"device memory", memory, MinDeviceMemoryBytes, true},
	} {
		// Zero means "leave the device default alone", so it is always allowed.
		if !c.applicable {
			continue
		}
		if c.got != 0 && c.got < c.min {
			return fmt.Errorf("%s size %d is below the %d byte minimum this simulator can build",
				c.name, c.got, c.min)
		}
	}
	return nil
}

// deviceHasMALL reports whether a device builds a MALL at all. Named per device
// rather than read off a built platform, because validation has to answer before
// anything is built. An unrecognised name answers false, which leaves the MALL
// unchecked; New refuses unknown names immediately after.
func deviceHasMALL(deviceName string) bool {
	device, err := LookupDevice(deviceName)
	if err != nil {
		return false
	}
	return device.HasMALL
}

type Harness struct {
	cfg         Config
	driver      *driver.Driver
	ctx         *driver.Context
	queue       *driver.CommandQueue
	codeObject  *insts.KernelCodeObject
	elfBytes    []byte
	codeObjects map[string]*insts.KernelCodeObject
	// stream is the live-stream pacer, non-nil only when a sink is installed.
	// Consulted through streamHook, which is nil in the common case, so the
	// per-instruction check is a single nil test.
	stream *flusher

	// memMu guards mem: the live readout reads that map from the ENGINE goroutine
	// while Malloc and Free write it from the main one. A concurrent map read and
	// write is a runtime throw, not a wrong number.
	memMu             sync.Mutex
	mem               map[uint64]int
	vramCapacity      uint64
	sim               *simulation.Simulation
	hooks             *simHooks
	startTimeUnixNano uint64

	// lastKernelName is the most recently launched symbol, for the OTLP
	// metrics contract.
	lastKernelName     string
	lastKernelGrid     [3]uint32
	lastKernelBlock    [3]uint32
	launchSequence     uint64
	lastLaunchSequence uint64
	// launchDramReadBytes and launchDramWriteBytes are the DRAM totals at the moment
	// of the most recent launch, so the live readout reports what THIS kernel moved
	// rather than the setup cost ahead of it.
	launchDramReadBytes  uint64
	launchDramWriteBytes uint64

	// The same baseline for every cache level: the host's own copies and memsets
	// ahead of the launch are real traffic at every level. Indexed by the
	// memLevel* constants so adding a level needs no new field here.
	launchCacheReadBytes  [memLevelCount]uint64
	launchCacheWriteBytes [memLevelCount]uint64
	// lastLaunchSimTimePs is the engine clock when the most recent launch was
	// enqueued, so elapsed time is measured since THIS kernel rather than since the
	// engine started ticking. Written with the same absence of a lock as
	// lastLaunchSequence: both are host-side facts about an undrained launch.
	lastLaunchSimTimePs uint64

	// kernelMu guards the per-kernel accounting below, which the stream samples from
	// the ENGINE goroutine while a launch or a drain retires from the main one.
	kernelMu sync.Mutex

	// kernelTraffic is one entry per distinct kernel name, first-launched order, and
	// nothing is ever removed: the panel resolves a kernel by its index here.
	kernelTraffic []KernelTraffic
	// kernelIndex maps a kernel name to its entry in kernelTraffic.
	kernelIndex map[string]int
	// pendingKernel is the entry index of the launch in flight, or -1.
	pendingKernel int
	// observedDRAM and observedCache are the counters as of the last observation.
	observedDRAM  collectedDRAMStats
	observedCache [memLevelCount]collectedDRAMStats
	// kernelTrafficDirty is set when a launch is retired, so the next final sample is
	// emitted even if the clock has not moved: the drain retires the last launch after
	// the pacing hook has already emitted, and without this the final sample reports
	// one launch short.
	kernelTrafficDirty bool

	// lds is one drain, cached so repeated reads cannot disagree with one another.
	ldsOnce sync.Once
	lds     *ldsState

	// The code object's DWARF line table, read once per ELF. See srcline.go.
	sourceOnce sync.Once
	source     sourceCache

	// closeOnce runs Close's two-call shutdown at most once: a second
	// Driver.Terminate has no goroutine left to receive it. See Close.
	closeOnce sync.Once

	// closed records that Close has run, so Drain refuses rather than block on a
	// stopped goroutine. Written inside closeOnce and read outside it, which is
	// safe because a Harness is single-goroutine.
	closed bool

	// deviceName is the resolved registry key, so the telemetry attribute cannot
	// name a different GPU than the one MGPUSim built.
	deviceName string
}

// New builds the timing platform for Config.Device, mirroring
// amd/samples/runner minus flags/RTM/sqlite reporting, and starts the driver.
// It panics rather than building something the caller did not ask for: an unknown
// device, one carrying a DisabledReason, or one yielding no measurable CUs.
func New(cfg Config) *Harness {
	// Resolve the device before building: an unknown or unavailable name must
	// fail here, where the message can name it.
	device := cfg.Device
	if device.Name == "" {
		device = DefaultDevice()
	}
	resolved, err := LookupDevice(device.Name)
	if err != nil {
		panic("harness: " + err.Error())
	}
	if resolved.DisabledReason != "" {
		panic("harness: device " + resolved.Name + " is not available: " + resolved.DisabledReason)
	}
	// Refused here rather than built: WithGPUMemSize(0) is legal and produces a
	// platform with no device memory, which fails at the first allocation as "out
	// of memory" on a device that looks like it has none.
	if resolved.MemoryBytes == 0 {
		panic(fmt.Sprintf("harness: device %q declares no device memory; add MemoryBytes to its registry entry",
			resolved.Name))
	}

	sim := simulation.MakeBuilder().
		WithoutMonitoring().
		WithoutDataRecording().
		Build()

	// The memory figure is resolved once, here, and used for both the platform and
	// the allocator's limit, so the two cannot disagree.
	memoryBytes := resolved.MemoryBytes
	if cfg.DeviceMemoryBytes > 0 {
		memoryBytes = cfg.DeviceMemoryBytes
	}

	b := timingconfig.MakeBuilder().
		WithSimulation(sim).
		WithNumGPUs(1).
		// SimulatorType, NOT resolved.Name: the builder switches on its own GPU-type
		// names and builds an r9nano for anything it does not recognise. See the field's
		// comment on Device.
		WithGPUType(resolved.SimulatorType).
		// The resolved figure, applied rather than reported: this is what bounds
		// the device allocator, so a kernel that asks for more than the catalog
		// calls this device's memory fails here instead of quietly getting it.
		WithGPUMemSize(memoryBytes)

	// The cache overrides, applied only when asked for: the builders read a zero
	// as a real size, so passing an unset field through would build a zero-byte
	// cache rather than leaving the device's own default in place.
	if cfg.L1VBytes > 0 {
		b = b.WithL1VCacheSize(cfg.L1VBytes)
	}
	if cfg.L2Bytes > 0 {
		b = b.WithL2CacheSize(cfg.L2Bytes)
	}
	if cfg.MALLBytes > 0 {
		b = b.WithMALLCacheSize(cfg.MALLBytes)
	}
	if cfg.DRAMBytes > 0 {
		b = b.WithDramSize(cfg.DRAMBytes)
	}

	// Read back off the chain rather than off the registry, so the catalog's
	// vramBytes and the limit the allocator enforces are the same value by
	// construction. Currently a tautology, and here to catch a With* call appended
	// after this one that resets the size.
	if built := b.GPUMemSize(); built != memoryBytes {
		panic(fmt.Sprintf("harness: device %q asked for %d bytes of device memory and the platform configuration reports %d",
			resolved.Name, memoryBytes, built))
	}

	// After the device is resolved, because whether a MALL size applies depends on
	// which device this is.
	if err := ValidateSizeOverrides(resolved.Name,
		cfg.L1VBytes, cfg.L2Bytes, cfg.MALLBytes, cfg.DeviceMemoryBytes); err != nil {
		panic("harness: " + err.Error())
	}

	h := &Harness{
		cfg:               cfg,
		mem:               map[uint64]int{},
		sim:               sim,
		codeObjects:       map[string]*insts.KernelCodeObject{},
		startTimeUnixNano: uint64(time.Now().UnixNano()),
		vramCapacity:      memoryBytes,
		deviceName:        resolved.Name,
		kernelIndex:       map[string]int{},
		pendingKernel:     -1,
	}
	h.driver = b.Build()

	// Before initHooks, which hands the pacer to every CU's instruction tracer. A
	// sink is only ever installed by the wasm layer, so natively the tracers carry
	// a nil hook.
	if MetricsSink != nil {
		h.stream = &flusher{harness: h}
	}

	if cfg.MaxInst > 0 {
		stopper := newInstStopper(uint64(cfg.MaxInst), cfg.StopOnMaxInst)
		for _, comp := range sim.Components() {
			if cu, ok := comp.(interface {
				tracing.NamedHookable
				Name() string
			}); ok && isCUName(comp.Name()) {
				tracing.CollectTrace(cu, stopper)
			}
		}
	}

	// Telemetry hooks for OTLP metrics: kernel-time, per-CU/SIMD instruction
	// counters, CPI stacks, cache/TLB hit-rate + latency, and DRAM traffic.
	h.initHooks()

	// A device whose CUs cannot be hooked yields no counters, and the dashboard
	// renders an empty room rather than an error. Fail here instead, naming the
	// device. The gate is isCUName && isTimingCU (metrics.go:77), so zero means
	// either the CUs are named differently or they are not *cu.Comp.
	if len(h.hooks.instCounters) == 0 {
		panic(fmt.Sprintf("harness: device %q produced no measurable compute units, "+
			"so it cannot be measured; either isCUName does not match its component "+
			"naming or its CUs are not *cu.Comp", resolved.Name))
	}

	// The driver's goroutine processes command queues; DrainCommandQueue
	// blocks forever without it.
	h.driver.Run()

	h.ctx = h.driver.Init()
	h.driver.SelectGPU(h.ctx, 1)
	h.queue = h.driver.CreateCommandQueue(h.ctx)

	return h
}

// isCUName matches the r9nano builder's "<GPU[i]>.SA[j].CU[k]". The suffix
// check alone fails: component names always end with "]".
func isCUName(name string) bool {
	return strings.Contains(name, ".CU[") && strings.HasSuffix(name, "]")
}

// LoadCodeObject parses a code-object ELF from memory. All kernels in the ELF are
// available; kernels are loaded lazily by name at LaunchKernel time.
func (h *Harness) LoadCodeObject(elfBytes []byte) {
	h.elfBytes = elfBytes
	h.codeObjects = map[string]*insts.KernelCodeObject{}
	// The line table belongs to the bytes just replaced, so the cache starts fresh.
	h.sourceOnce = sync.Once{}
	h.source = sourceCache{}
}

// loadCodeObject loads (and caches) the named kernel from the stored ELF.
// It panics if no ELF has been loaded or the kernel is absent.
func (h *Harness) loadCodeObject(kernelName string) {
	if co, ok := h.codeObjects[kernelName]; ok {
		h.codeObject = co
		return
	}
	if h.elfBytes == nil {
		panic("harness: LoadCodeObject must be called before LaunchKernel")
	}
	assertKernelPresent(h.elfBytes, kernelName)
	co := insts.LoadKernelCodeObjectFromBytes(h.elfBytes, kernelName)
	if co == nil {
		panic("harness: kernel not found: " + kernelName)
	}
	// hipcc writes enable_sgpr_user_sgpr_count = 0 into the COV5 descriptor's
	// compute_pgm_rsrc2 for gfx803, but the emitted code reserves s[0:3] for the
	// private segment buffer and reads the kernarg pointer from s[4:5].
	// MGPUSim's heuristic keys off that descriptor bit, so override it.
	if co.Version == insts.CodeObjectV5 && co.MachineVersionMajor == 8 {
		co.EnableSgprPrivateSegmentBuffer = true
	}
	h.codeObjects[kernelName] = co
	h.codeObject = co
}

// Malloc allocates device memory and returns the device pointer.
//
// The out-of-memory panic is rewritten rather than pre-checked: a pre-check would
// have to guess whether the driver rounds the request up to a page, and a guess one
// page short refuses an allocation the allocator would have made. The driver's
// verdict is caught here and restated with the device, the held amount, the
// requested amount and the limit.
func (h *Harness) Malloc(size int) (ptr uint64) {
	if size <= 0 {
		panic("harness: Malloc size must be positive")
	}
	// Recovered and re-panicked rather than returned as an error, because every
	// other misuse on this Harness panics and a caller that had to check two
	// failure modes would eventually check one. The recover is narrowed to the
	// driver's own allocation so a panic from anywhere else in the call below
	// still surfaces as itself.
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		if message, ok := recovered.(string); !ok || !strings.Contains(message, "out of memory") {
			panic(recovered)
		}
		// All three figures: held and requested cannot be compared without the limit.
		panic(fmt.Sprintf(
			"harness: %s ran out of device memory: %s of %s is allocated and %d bytes were requested",
			h.deviceName, formatBytes(h.usedDeviceMemory()), formatBytes(h.vramCapacity), size))
	}()

	allocated := h.driver.AllocateMemory(h.ctx, uint64(size))
	h.memMu.Lock()
	h.mem[uint64(allocated)] = size
	h.memMu.Unlock()
	return uint64(allocated)
}

// Free releases a previous Malloc.
func (h *Harness) Free(ptr uint64) {
	h.memMu.Lock()
	_, ok := h.mem[ptr]
	if ok {
		delete(h.mem, ptr)
	}
	h.memMu.Unlock()
	if !ok {
		panic(fmt.Sprintf("harness: Free of unknown ptr 0x%x", ptr))
	}
	if err := h.driver.FreeMemory(h.ctx, driver.Ptr(ptr)); err != nil {
		panic(err)
	}
}

// usedDeviceMemory is the total of the host's live allocations, not the
// allocator's occupancy: MGPUSim's EnqueueLaunchKernel also allocates the code
// object, the kernarg segment and one AQL packet per launch and never frees them
// (third_party/mgpusim/amd/driver/kernel.go:26). The driver's own accounting is
// unexported, so the live panel labels this as the host's view.
func (h *Harness) usedDeviceMemory() uint64 {
	h.memMu.Lock()
	defer h.memMu.Unlock()
	var total uint64
	for _, size := range h.mem {
		total += uint64(size)
	}
	return total
}

// MemcpyH2D copies host bytes to a device buffer.
func (h *Harness) MemcpyH2D(ptr uint64, data []byte) {
	h.driver.MemCopyH2D(h.ctx, driver.Ptr(ptr), data)
}

// MemcpyD2H copies size bytes from a device buffer to the host.
func (h *Harness) MemcpyD2H(ptr uint64, size int) []byte {
	dst := make([]byte, size)
	h.driver.MemCopyD2H(h.ctx, &dst, driver.Ptr(ptr))
	return dst
}

// LaunchKernel enqueues a kernel launch. Explicit args are packed in parameter
// order (pointers, uint32s, float32s), followed by the COV5 hidden-argument
// block gfx803 kernels expect (group sizes, remainders, global offsets, grid).
//
// grid and block are MGPUSim's convention: grid counts total work items, not
// work groups. Block dims must be 1..65535 (the driver's workgroup size is
// uint16) and grid dims non-zero; violations panic.
func (h *Harness) LaunchKernel(
	name string,
	grid, block [3]uint32,
	args KernelArgs,
) {
	h.validateLaunch(name, grid, block)
	argStruct := h.packArgs(args, grid, block)
	h.enqueueLaunch(name, grid, block, argStruct)
}

func (h *Harness) LaunchKernelRaw(
	name string,
	grid, block [3]uint32,
	rawArgs []byte,
) {
	h.validateLaunch(name, grid, block)
	argStruct := h.packRawArgs(rawArgs, grid, block, h.codeObject.KernargSegmentByteSize)
	h.enqueueLaunch(name, grid, block, argStruct)
}

func (h *Harness) validateLaunch(name string, grid, block [3]uint32) {
	if block[0] == 0 || block[1] == 0 || block[2] == 0 {
		panic(fmt.Sprintf(
			"harness: block dims must be non-zero, got [%d %d %d] (kernel %q)",
			block[0], block[1], block[2], name))
	}
	if block[0] > 65535 || block[1] > 65535 || block[2] > 65535 {
		panic(fmt.Sprintf(
			"harness: block dims must be <= 65535, got [%d %d %d] (kernel %q)",
			block[0], block[1], block[2], name))
	}
	if grid[0] == 0 || grid[1] == 0 || grid[2] == 0 {
		panic(fmt.Sprintf(
			"harness: grid dims must be non-zero, got [%d %d %d] (kernel %q)",
			grid[0], grid[1], grid[2], name))
	}
	if h.elfBytes == nil {
		panic("harness: LoadCodeObject must be called before LaunchKernel")
	}
	h.loadCodeObject(name)
	h.lastKernelName = name
	h.lastKernelGrid = grid
	h.lastKernelBlock = block
}

func (h *Harness) enqueueLaunch(name string, grid, block [3]uint32, argStruct interface{}) {
	h.launchSequence++
	h.lastLaunchSequence = h.launchSequence
	wgSize := [3]uint16{uint16(block[0]), uint16(block[1]), uint16(block[2])}
	h.driver.EnqueueLaunchKernel(h.queue, h.codeObject, grid, wgSize, argStruct)
	// The live readout's baselines, taken HERE rather than in validateLaunch.
	// EnqueueLaunchKernel writes the kernarg segment and an AQL packet into device
	// memory on its way past, so a baseline taken before it charges the launch's own
	// bookkeeping to the kernel.
	h.lastLaunchSimTimePs = uint64(h.sim.GetEngine().CurrentTime())
	dram := h.collectDRAM()
	h.launchDramReadBytes, h.launchDramWriteBytes = dram.readBytes, dram.writeBytes

	// Same for the cache levels, from one snapshot taken here so every level's
	// baseline and DRAM's are all read at the same instant.
	caches := h.collectCacheBytes()
	for level := 0; level < memLevelCount; level++ {
		h.launchCacheReadBytes[level] = caches[level].readBytes
		h.launchCacheWriteBytes[level] = caches[level].writeBytes
	}

	// Same baseline, for the per-kernel breakdown: this launch is charged whatever
	// it moves from here, and the one before it is closed out at the same instant.
	h.beginKernelLaunch(name, h.lastLaunchSimTimePs)
}

// packArgs builds a reflect.StructOf matching the kernel's parameter order
// (ptrs, uint32s, floats, then the COV5 hidden block) and fills it. Within the
// hidden block: block counts at +0, group sizes +12, remainders +18, pad +24,
// global offsets +40, grid dims +64 (66 bytes total). Its base offset is
// hiddenBlockOffsetFor, because the kernel's prologue reads blockDim back out
// of the kernarg segment.
func (h *Harness) packArgs(args KernelArgs, grid, block [3]uint32) interface{} {
	fields := make([]reflect.StructField, 0, 32)
	values := make([]reflect.Value, 0, 32)

	add := func(name string, t reflect.Type, v reflect.Value) {
		fields = append(fields, reflect.StructField{Name: name, Type: t})
		values = append(values, v)
	}

	for _, p := range args.Pointers {
		add(fmt.Sprintf("P%d", len(fields)),
			reflect.TypeOf(driver.Ptr(0)), reflect.ValueOf(driver.Ptr(p)))
	}
	for _, u := range args.Uint32s {
		add(fmt.Sprintf("U%d", len(fields)),
			reflect.TypeOf(uint32(0)), reflect.ValueOf(u))
	}
	for _, f := range args.Floats {
		add(fmt.Sprintf("F%d", len(fields)),
			reflect.TypeOf(float32(0)), reflect.ValueOf(f))
	}

	// binary.Write packs fields back-to-back, so the explicit args occupy exactly
	// bytesSoFar and the hidden block starts at the next multiple of 8. A trailing
	// 4-byte remainder takes one pad field.
	bytesSoFar := 0
	for _, f := range fields {
		bytesSoFar += int(f.Type.Size())
	}
	for bytesSoFar < hiddenBlockOffsetFor(bytesSoFar) {
		add(fmt.Sprintf("Pad%d", len(values)),
			reflect.TypeOf(uint32(0)), reflect.ValueOf(uint32(0)))
		bytesSoFar += 4
	}

	addHiddenFields(add, grid, block)

	dynamicType := reflect.StructOf(fields)
	argPtr := reflect.New(dynamicType)
	argVal := argPtr.Elem()
	for i, v := range values {
		argVal.Field(i).Set(v)
	}

	// EnqueueLaunchKernel serializes with binary.Write; hand it a pointer so
	// prepareLocalMemory can copy it.
	return argPtr.Interface()
}

func (h *Harness) packRawArgs(rawArgs []byte, grid, block [3]uint32, segmentSize uint64) interface{} {
	if uint64(len(rawArgs)) > segmentSize {
		panic(fmt.Sprintf("harness: raw kernel argument block is %d bytes, descriptor allows %d", len(rawArgs), segmentSize))
	}
	// blockDim is not an SGPR here. clang lowers the workgroup_size builtins to
	// 16-bit loads from the kernarg segment at hidden+12/+14/+16, so the hidden
	// block must sit exactly where the kernel's prologue looks for it: immediately
	// after the explicit args, rounded up to a multiple of 8.
	hiddenOffset := hiddenBlockOffsetFor(len(rawArgs))
	hasHiddenBlock := uint64(hiddenOffset+hiddenBlockSize) <= segmentSize
	packedSize := int(segmentSize)
	if hasHiddenBlock {
		packedSize = hiddenOffset + hiddenBlockSize
	}

	raw := make([]byte, int(segmentSize))
	copy(raw, rawArgs)
	if hasHiddenBlock {
		hidden := struct {
			BlockCounts   [3]uint32
			GroupSizes    [3]uint16
			Remainders    [3]uint16
			Padding       [16]byte
			GlobalOffsets [3]int64
			GridDims      uint16
		}{
			BlockCounts:   [3]uint32{grid[0] / block[0], grid[1] / block[1], grid[2] / block[2]},
			GroupSizes:    [3]uint16{uint16(block[0]), uint16(block[1]), uint16(block[2])},
			Remainders:    [3]uint16{uint16(grid[0] % block[0]), uint16(grid[1] % block[1]), uint16(grid[2] % block[2])},
			GlobalOffsets: [3]int64{0, 0, 0},
			GridDims:      hiddenGridDims(grid),
		}
		var hiddenBytes bytes.Buffer
		if err := binary.Write(&hiddenBytes, binary.LittleEndian, hidden); err != nil {
			panic(fmt.Errorf("harness: encode hidden kernel arguments: %w", err))
		}
		if hiddenBytes.Len() != hiddenBlockSize {
			panic(fmt.Sprintf("harness: encoded hidden kernel arguments are %d bytes, want %d", hiddenBytes.Len(), hiddenBlockSize))
		}
		copy(raw[hiddenOffset:], hiddenBytes.Bytes())
	}

	arrayType := reflect.ArrayOf(packedSize, reflect.TypeOf(byte(0)))
	argType := reflect.StructOf([]reflect.StructField{{Name: "Bytes", Type: arrayType}})
	argPtr := reflect.New(argType)
	reflect.Copy(argPtr.Elem().Field(0), reflect.ValueOf(raw[:packedSize]))
	return argPtr.Interface()
}

// hiddenBlockOffsetFor is where the COV5 hidden block starts. The ABI aligns
// the explicit-arg block up to 8 bytes, and clang's workgroup-size reads are
// emitted against that aligned base.
func hiddenBlockOffsetFor(explicitArgBytes int) int { return (explicitArgBytes + 7) &^ 7 }

// hiddenBlockSize is the COV5 hidden block size, matching blockGroupSizeBytes
// in COV5KernelArgs: 3 u32 block counts + 3 u16 group sizes + 3 u16
// remainders + 16 pad + 3 i64 global offsets + 1 u16 grid dims.
const hiddenBlockSize = 66

func hiddenGridDims(grid [3]uint32) uint16 {
	if grid[2] != 1 {
		return 3
	}
	if grid[1] != 1 {
		return 2
	}
	return 1
}

// addHiddenFields appends the COV5 hidden-argument fields (see the packArgs
// layout comment). Block counts are work groups per dimension (grid/block, since
// MGPUSim's grid is total work items), group sizes are the block dims,
// remainders are grid%block, and GridDims counts the non-unity grid dimensions.
func addHiddenFields(add func(name string, t reflect.Type, v reflect.Value), grid, block [3]uint32) { //nolint:lll
	gridDims := uint16(1)
	if grid[1] != 1 || grid[2] != 1 {
		gridDims = 2
	}
	if grid[2] != 1 {
		gridDims = 3
	}

	add("HiddenBlockCountX", reflect.TypeOf(uint32(0)),
		reflect.ValueOf(grid[0]/block[0]))
	add("HiddenBlockCountY", reflect.TypeOf(uint32(0)),
		reflect.ValueOf(grid[1]/block[1]))
	add("HiddenBlockCountZ", reflect.TypeOf(uint32(0)),
		reflect.ValueOf(grid[2]/block[2]))
	add("HiddenGroupSizeX", reflect.TypeOf(uint16(0)),
		reflect.ValueOf(uint16(block[0])))
	add("HiddenGroupSizeY", reflect.TypeOf(uint16(0)),
		reflect.ValueOf(uint16(block[1])))
	add("HiddenGroupSizeZ", reflect.TypeOf(uint16(0)),
		reflect.ValueOf(uint16(block[2])))
	add("HiddenRemainderX", reflect.TypeOf(uint16(0)),
		reflect.ValueOf(uint16(grid[0]%block[0])))
	add("HiddenRemainderY", reflect.TypeOf(uint16(0)),
		reflect.ValueOf(uint16(grid[1]%block[1])))
	add("HiddenRemainderZ", reflect.TypeOf(uint16(0)),
		reflect.ValueOf(uint16(grid[2]%block[2])))
	add("HiddenPadding", reflect.TypeOf([16]byte{}),
		reflect.ValueOf([16]byte{}))
	add("HiddenGlobalOffsetX", reflect.TypeOf(int64(0)),
		reflect.ValueOf(int64(0)))
	add("HiddenGlobalOffsetY", reflect.TypeOf(int64(0)),
		reflect.ValueOf(int64(0)))
	add("HiddenGlobalOffsetZ", reflect.TypeOf(int64(0)),
		reflect.ValueOf(int64(0)))
	add("HiddenGridDims", reflect.TypeOf(uint16(0)),
		reflect.ValueOf(gridDims))
}

// Drain blocks until every command has completed, then waits for the engine
// goroutine to idle so tracer state is safe to read (driver.go:163).
//
// It is not a shutdown: the goroutine New started keeps running and the harness
// stays usable. Draining a closed harness panics rather than hanging -- the
// queue signal would have no receiver left.
func (h *Harness) Drain() {
	if h.closed {
		panic("harness: Drain on a closed harness; Drain outstanding work before Close")
	}
	h.driver.DrainCommandQueue(h.queue)
	h.driver.WaitForEngineIdle()
	// The last launch's execution window closed with the drain, so this is the only
	// moment its traffic can be attributed to it.
	h.closeKernelLaunch(uint64(h.sim.GetEngine().CurrentTime()))
}

// Close shuts the harness down: driver.Terminate() stops the background
// goroutine, then sim.Terminate() closes the recorders, the two-call sequence
// MGPUSim's own runner ends with (runner.go:186).
//
// Idempotent because it has to be: Driver.Terminate is a send on an unbuffered
// channel received exactly once, so a second call would block forever. Additive,
// not a replacement for Drain: Drain first.
func (h *Harness) Close() {
	if h == nil || h.driver == nil {
		return
	}
	h.closeOnce.Do(func() {
		h.closed = true
		h.driver.Terminate()
		if h.sim != nil {
			h.sim.Terminate()
		}
	})
}

// assertKernelPresent panics with "kernel not found: <name>" unless the ELF's
// symbol table contains a .text symbol with exactly that name. It duplicates the
// loader's symbol-scan criteria (amd/insts/hsaco.go:192-203) and must run BEFORE
// insts.LoadKernelCodeObjectFromBytes, which reports missing kernels via
// log.Fatalf (process exit, not a recoverable panic).
func assertKernelPresent(elfBytes []byte, kernelName string) {
	executable, err := elf.NewFile(bytes.NewReader(elfBytes))
	if err != nil {
		panic(fmt.Sprintf("harness: not a valid ELF code object: %v", err))
	}
	defer executable.Close()

	symbols, err := executable.Symbols()
	if err != nil {
		return // no symbol table: the loader treats .text as one kernel
	}
	textSection := executable.Section(".text")
	if textSection == nil {
		return // loader will log.Fatal on this; nothing to pre-check
	}
	for _, sym := range symbols {
		if sym.Section == elf.SHN_UNDEF {
			continue
		}
		if int(sym.Section) >= len(executable.Sections) {
			continue
		}
		sec := executable.Sections[sym.Section]
		if sec.Name == ".text" && sym.Size > 0 && sym.Name == kernelName {
			return
		}
	}
	panic("harness: kernel not found: " + kernelName)
}

// formatBytes renders a byte count the way a person reads one: three decimal
// digits and a binary unit.
func formatBytes(value uint64) string {
	const unit = 1024
	if value < unit {
		return fmt.Sprintf("%d B", value)
	}
	div, exp := uint64(unit), 0
	for n := value / unit; n >= unit && exp < 3; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %ciB", float64(value)/float64(div), "KMGT"[exp])
}
