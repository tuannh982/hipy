//go:build js && wasm

package wasmexec

import (
	"bytes"
	"debug/elf"
	"encoding/json"
	"fmt"

	"hipy/simulator/harness"
	"hipy/simulator/internal/ldsanalysis"
	"hipy/simulator/telemetry"
)

var (
	h            *harness.Harness
	result       []byte
	pending      []byte
	pendingReady bool
	stdout       []byte
	maxInst      int32
	deviceName   string

	// overrides holds the Customize sizes configure() was given, kept until the
	// harness is built. Zero fields mean the device default.
	overrides   harness.Config
	cutoffFired bool
	// allocations retains every buffer so pointers stay valid until teardown.
	allocations      [][]byte
	lastMallocStatus int32
)

// configure records the device and the instruction budget for the run
// ensureHarness will build.
//
// ONE-SHOT PER INSTANCE: the device and budget are baked into a platform at
// construction, so a later configure could only pretend to change a platform that
// already exists. Reading the catalog does not consume the one shot, which is why
// catalog goes through harness.CatalogFor rather than ensureHarness.
//
// The device is a Go string, which //go:wasmexport lowers to a (pointer, length)
// pair of i32s, so every JavaScript caller must write the name into Go memory and
// pass both halves.
//
// The four size arguments are the Customize overrides, in bytes, and zero means
// "whatever the device builder defaults to" for each. They arrive on the same call
// as the device because the overrides are meaningless without it: L1V is per CU, so
// the number of CUs is part of what the figure means.
//
// i32 rather than i64 because //go:wasmexport passes them to JS as signed numbers,
// and a size at or above 2 GiB would arrive negative. The conversion below is the
// only place that matters, and it is unsigned on purpose -- see the note on
// ldsanalysis for the same trap on the pointer side.
//
//go:wasmexport configure
func configure(
	requestedMaxInst int32,
	device string,
	l1vBytes int32,
	l2Bytes int32,
	mallBytes int32,
	deviceMemoryBytes int32,
) (status int32) {
	defer exportError(&status)
	if h != nil {
		return setError("configure must be called before loadCodeObject")
	}
	// Validation lives here and nowhere else: the device arrives from the
	// browser, and this is the only boundary between it and the simulator.
	if _, err := harness.LookupDevice(device); err != nil {
		return setError(err)
	}
	maxInst = requestedMaxInst
	deviceName = device
	l1v, l2, mall, memory := uint64(uint32(l1vBytes)), uint64(uint32(l2Bytes)),
		uint64(uint32(mallBytes)), uint64(uint32(deviceMemoryBytes))
	if err := harness.ValidateSizeOverrides(device, l1v, l2, mall, memory); err != nil {
		return setError(err)
	}
	overrides = harness.Config{
		L1VBytes:          l1v,
		L2Bytes:           l2,
		MALLBytes:         mall,
		DeviceMemoryBytes: memory,
	}
	cutoffFired = false
	return 0
}

func ensureHarness() {
	if h == nil {
		h = harness.New(harness.Config{
			MaxInst:       int(maxInst),
			Device:        harness.Device{Name: deviceName},
			StopOnMaxInst: func() { cutoffFired = true },
			// Spread over the Config literal rather than merged afterwards, so
			// the overrides a run was configured with are the ones the platform
			// was built from.
			L1VBytes:          overrides.L1VBytes,
			L2Bytes:           overrides.L2Bytes,
			MALLBytes:         overrides.MALLBytes,
			DeviceMemoryBytes: overrides.DeviceMemoryBytes,
			// The browser build is the one host that has to have this. It is a
			// field on Config rather than an import inside package harness so
			// that harness itself still compiles against an unpatched MGPUSim
			// for the patch A/B; see package ldswire. Omitting it here would
			// not fail -- the ldsAnalysis export would return an empty report
			// and the tab would say "no conflict" over zero rows.
			LDSDrain: ldsanalysis.Drain,
		})
	}
}

func setResult(data []byte) {
	result = append(result[:0], data...)
}

func setError(value any) int32 {
	setResult([]byte(fmt.Sprint(value)))
	return 1
}

func exportError(resultCode *int32) {
	if recovered := recover(); recovered != nil {
		*resultCode = setError(recovered)
	}
}

// applyConfiguration validates a set of Customize sizes, stores them, and DISCARDS
// the current harness so the next run is built from them.
//
// The discard is the point. A harness holds a built platform, and that platform was
// constructed from whatever the sizes were when it was built; changing the sizes
// afterwards cannot reach into it. So saving a configuration necessarily costs a
// platform rebuild, which is why this is an explicit export the browser calls on
// "Save configuration" rather than something done silently on the next run -- a
// reader who typed a size and pressed Run would otherwise pay an unexplained
// rebuild, or worse, run against the old sizes and think the new ones applied.
//
// Validation happens before anything is stored, so a rejected save leaves the
// previous configuration exactly as it was.
//
//go:wasmexport applyConfiguration
func applyConfiguration(l1vBytes, l2Bytes, mallBytes, deviceMemoryBytes int32) (status int32) {
	defer exportError(&status)
	l1v, l2, mall, memory := uint64(uint32(l1vBytes)), uint64(uint32(l2Bytes)),
		uint64(uint32(mallBytes)), uint64(uint32(deviceMemoryBytes))
	if err := harness.ValidateSizeOverrides(deviceName, l1v, l2, mall, memory); err != nil {
		return setError(err)
	}

	overrides = harness.Config{
		L1VBytes:          l1v,
		L2Bytes:           l2,
		MALLBytes:         mall,
		DeviceMemoryBytes: memory,
	}

	// Drop the built harness so ensureHarness builds the next one from the sizes
	// stored above. Terminated rather than abandoned: a Go simulation holds real
	// memory and a goroutine, and leaving the old one running leaks both for the
	// life of the page. Safe to do while a run is in flight only because the
	// browser serialises these -- a save is refused while a run is live.
	if h != nil {
		h.Close()
		h = nil
	}
	return 0
}

//go:wasmexport alloc
func alloc(size int32) *byte {
	if size <= 0 {
		return nil
	}
	buffer := make([]byte, int(size))
	allocations = append(allocations, buffer)
	return bytePointer(buffer)
}

//go:wasmexport resultPtr
func resultPtr() *byte {
	return bytePointer(result)
}

//go:wasmexport resultLen
func resultLen() int32 {
	return int32(len(result))
}

//go:wasmexport loadCodeObject
func loadCodeObject(ptr, length int32) (status int32) {
	defer exportError(&status)
	if length < 0 {
		return setError("invalid code object length")
	}
	data := append([]byte(nil), inputBytes(ptr, length)...)
	file, err := elf.NewFile(bytes.NewReader(data))
	if err != nil {
		return setError(fmt.Errorf("invalid code object: %w", err))
	}
	_ = file.Close()
	ensureHarness()
	h.LoadCodeObject(data)
	return 0
}

// malloc returns a device pointer; mallocStatus is the independent status signal
// (zero success, nonzero an error in the result buffer).
//
//go:wasmexport malloc
func malloc(size int32) int32 {
	status := int32(0)
	defer func() { lastMallocStatus = status }()
	defer exportError(&status)
	if size <= 0 {
		status = setError("invalid allocation size")
		return 0
	}
	ensureHarness()
	ptr := h.Malloc(int(size))
	if ptr > uint64(^uint32(0)) {
		status = setError(fmt.Sprintf("device pointer does not fit in i32: 0x%x", ptr))
		return 0
	}
	setResult(nil)
	return int32(uint32(ptr))
}

// mallocStatus returns the status from the most recent malloc call.
//
//go:wasmexport mallocStatus
func mallocStatus() int32 {
	return lastMallocStatus
}

//go:wasmexport free
func free(ptr int32) (status int32) {
	defer exportError(&status)
	ensureHarness()
	h.Free(uint64(uint32(ptr)))
	return 0
}

//go:wasmexport memcpyH2D
func memcpyH2D(ptr int32, srcPtr, length int32) (status int32) {
	defer exportError(&status)
	if length < 0 {
		return setError("invalid copy length")
	}
	ensureHarness()
	h.MemcpyH2D(uint64(uint32(ptr)), append([]byte(nil), inputBytes(srcPtr, length)...))
	return 0
}

//go:wasmexport memcpyD2H
func memcpyD2H(ptr int32, dstPtr, length int32) (status int32) {
	defer exportError(&status)
	if length < 0 {
		return setError("invalid copy length")
	}
	ensureHarness()
	data := h.MemcpyD2H(uint64(uint32(ptr)), int(length))
	copy(inputBytes(dstPtr, length), data)
	return 0
}

//go:wasmexport setKernelArgs
func setKernelArgs(ptr, length int32) (status int32) {
	defer exportError(&status)
	pending = nil
	pendingReady = false
	if length < 0 {
		return setError("invalid kernel argument length")
	}
	pending = make([]byte, int(length))
	copy(pending, inputBytes(ptr, length))
	pendingReady = true
	return 0
}

//go:wasmexport launchKernel
func launchKernel(namePtr, nameLen, gx, gy, gz, bx, by, bz, sharedMemBytes int32) (status int32) {
	defer exportError(&status)
	defer func() {
		pending = nil
		pendingReady = false
	}()
	if nameLen < 0 || sharedMemBytes < 0 || gx <= 0 || gy <= 0 || gz <= 0 || bx <= 0 || by <= 0 || bz <= 0 {
		return setError("invalid kernel launch dimensions, shared-memory size, or name length")
	}
	name := string(inputBytes(namePtr, nameLen))
	if sharedMemBytes > 0 {
		return setError(fmt.Sprintf("dynamic shared memory is not supported in v1: kernel %q requested %d bytes; use static __shared__ memory", name, sharedMemBytes))
	}
	if !pendingReady {
		return setError(fmt.Sprintf("kernel %q was launched without an argument block", name))
	}
	ensureHarness()
	h.LaunchKernelRaw(name, [3]uint32{uint32(gx), uint32(gy), uint32(gz)}, [3]uint32{uint32(bx), uint32(by), uint32(bz)}, pending)
	return 0
}

//go:wasmexport drain
func drain() (status int32) {
	defer exportError(&status)
	ensureHarness()
	h.Drain()
	// One last sample, now that the engine is idle, so the stream's last point
	// agrees with the finished body read after this returns. See
	// harness.EmitFinalSample for why dirty lines flushed on the way out would
	// otherwise be missing.
	h.EmitFinalSample()
	if cutoffFired {
		return 1
	}
	return 0
}

//go:wasmexport metrics
func metrics() (status int32) {
	defer exportError(&status)
	ensureHarness()
	data, err := telemetry.MarshalMetricsRequest(h.OTLPMetrics())
	if err != nil {
		return setError(err)
	}
	setResult(data)
	return int32(len(data))
}

// ldsAnalysis returns the LDS bank analysis as plain JSON rather than OTLP:
// per-lane addresses are bulk data, and spans would misrepresent them. Not
// forwarded to a collector.
//
//go:wasmexport ldsAnalysis
func ldsAnalysis() (status int32) {
	defer exportError(&status)
	ensureHarness()
	data, err := json.Marshal(h.LDSAnalysis())
	if err != nil {
		return setError(err)
	}
	setResult(data)
	return int32(len(data))
}

// dashboardSchema returns how the live stream should be drawn: the charts, the
// units, the memory-hierarchy rows and the hit rates, as plain JSON.
//
// The browser reads it once per run, right after loadCodeObject, and renders the
// stream against it. It is NOT telemetry -- nothing here was measured, it is all a
// description of the device -- so it is not forwarded to a collector.
//
// Requires a configured harness, unlike catalog: it describes the platform this
// instance is about to run on, so reading it before configure would describe a
// device nobody asked for. See the ordering note on ldsAnalysis's read in
// website/src/workers/sim.worker.ts.
//
//go:wasmexport dashboardSchema
func dashboardSchema() (status int32) {
	defer exportError(&status)
	ensureHarness()
	data, err := json.Marshal(h.DashboardSchema())
	if err != nil {
		return setError(err)
	}
	setResult(data)
	return int32(len(data))
}

// catalog reports what the simulator is, as plain JSON: every device this build
// can run, with the figures of one of them.
//
// Not telemetry: nothing here is measured, it is all read off a platform that was
// just built. The browser calls it once at load, before any run, so the device
// select and About tab have something on first paint, and again whenever the
// selection moves to a device the body does not describe yet.
//
// THE ORDER IS PART OF THE CONTRACT. A catalog read leaves this instance
// configurable: it does not assign the package-level h, so a later configure on the
// same instance still succeeds. That is why the body comes from
// harness.CatalogFor rather than ensureHarness() + h.Catalog(), which would assign
// h and make the first run fail with "configure must be called before loadCodeObject".
//
// CatalogFor's harness is built from New(Config{Device: ...}) and nothing else:
// MaxInst 0 installs no instruction stopper and LDSDrain is nil, so adopting it
// for a run would quietly drop both. The two-build cost is the price of that
// guarantee. The platform it builds
// is drained and closed, so no platform is retained and the export can be called
// repeatedly (before configure, after configure, on a re-render) without each read
// costing a simulation.
//
// WHICH DEVICE IS DESCRIBED is this parameter, not the module-level deviceName.
// The parameter is what lets the browser ask about a device it has selected but not
// yet run: the body lists every device either way, but only one of them has its
// figures read, and reading them means building that platform. An empty name
// describes the registry default, which is what the page-load read wants.
//
// The name is a Go string, so //go:wasmexport lowers it to a (pointer, length)
// pair of i32s and every JavaScript caller must write it into Go memory and pass
// both halves -- the same shape configure takes.
//
//go:wasmexport catalog
func catalog(ptr, length int32) (status int32) {
	defer exportError(&status)
	if length < 0 {
		return setError("invalid device name length")
	}
	// The saved sizes, so the figures the browser shows after a save are the ones
	// the next run will actually build rather than the device's stock figures.
	body, err := harness.CatalogFor(string(inputBytes(ptr, length)), &overrides)
	if err != nil {
		return setError(err)
	}
	data, err := json.Marshal(body)
	if err != nil {
		return setError(err)
	}
	setResult(data)
	return int32(len(data))
}

//go:wasmexport writeStdout
func writeStdout(ptr, length int32) (status int32) {
	defer exportError(&status)
	if length < 0 {
		return setError("invalid stdout length")
	}
	stdout = append(stdout, inputBytes(ptr, length)...)
	return 0
}

//go:wasmexport stdoutPtr
func stdoutPtr() *byte {
	return bytePointer(stdout)
}

//go:wasmexport stdoutLen
func stdoutLen() int32 {
	return int32(len(stdout))
}

// Run parks the Go runtime forever. The module's exports stay callable because
// the runtime is still alive; it just has nothing of its own to do. This is the
// wasm entry point, so it is also where the live sink is installed -- see
// installStream.
func Run() {
	installStream()
	select {}
}
