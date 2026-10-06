package harness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeviceRegistryIsCoherent(t *testing.T) {
	def := DefaultDevice()
	if _, err := LookupDevice(def.Name); err != nil {
		t.Errorf("the default device %q is not in the registry: %v", def.Name, err)
	}

	all := Devices()
	if len(all) == 0 {
		t.Fatal("the registry is empty, so no device can be selected")
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].Name >= all[i].Name {
			t.Errorf("Devices() is not sorted: %q came before %q", all[i-1].Name, all[i].Name)
		}
	}
	for _, d := range all {
		if d.Name == "" {
			t.Error("a registry entry has an empty Name")
		}
		if d.Toolchain == "" {
			t.Errorf("device %q has no Toolchain, so the browser would have no driver to compile it with", d.Name)
		}
		if d.TargetArch == "" {
			t.Errorf("device %q has no TargetArch, so the toolchain would have nothing to emit", d.Name)
		}
		if d.Label == "" {
			t.Errorf("device %q has no Label, so the UI would render an empty option", d.Name)
		}
		// SimulatorType is the name timingconfig.Builder switches on, and a
		// misspelled one falls to its default r9nano branch silently, so the set of
		// names the builder knows is pinned here.
		if d.SimulatorType != "r9nano" && d.SimulatorType != "mi300x" {
			t.Errorf("device %q names SimulatorType %q, which timingconfig.Builder has no case for; "+
				"it would build an r9nano under this device's name", d.Name, d.SimulatorType)
		}
	}
}

func TestLookupDeviceRejectsUnknownNames(t *testing.T) {
	_, err := LookupDevice("no-such-device")
	if err == nil {
		t.Fatal("an unknown device name was accepted, so a typo would silently select a GPU")
	}
	// The error must name the known set: a bare "unknown device" leaves the
	// caller with nothing to do about it.
	if got := err.Error(); !strings.Contains(got, DefaultDevice().Name) {
		t.Errorf("the error %q does not name the known set, so it cannot be acted on", got)
	}
}

func TestDisabledDevicesAreStillListed(t *testing.T) {
	// Staging a disabled entry: the shipping devices are enabled, so without one this
	// loop cannot fail. Staging mutates a package global; see
	// TestNewRejectsADeviceItCannotBuild for why that is safe today.
	registry["unavailable-listed-device"] = Device{
		Name:           "unavailable-listed-device",
		Toolchain:      "amdgcn",
		TargetArch:     "gfx000",
		Label:          "A device this build cannot run",
		DisabledReason: "the pinned MGPUSim checkout has no platform for it",
	}
	t.Cleanup(func() { delete(registry, "unavailable-listed-device") })

	// A device that cannot run is returned, not dropped: the UI renders it as a
	// disabled option carrying the reason.
	listed := Devices()
	for _, d := range listed {
		if _, err := LookupDevice(d.Name); err != nil {
			t.Errorf("device %q is listed by Devices() but rejected by LookupDevice: %v", d.Name, err)
		}
	}

	var foundDisabled bool
	for _, d := range listed {
		if d.Name == "unavailable-listed-device" {
			foundDisabled = true
			if d.DisabledReason == "" {
				t.Error("Devices() listed the disabled device with an empty DisabledReason, " +
					"so the UI would render an enabled option for a device that cannot run")
			}
		}
	}
	if !foundDisabled {
		t.Error("Devices() dropped the disabled device, so the registry lies about what exists")
	}
}

// TestNewRejectsADeviceItCannotBuild pins the two ways New refuses to build: a
// name that is not in the registry, and an entry carrying a DisabledReason. Both
// panic rather than falling back to a GPU the caller did not ask for.
//
// The disabled case has no production entry, so the entry is staged into the
// registry for the duration of the check. Staging mutates a package global, which
// is safe today only because no test in this package calls t.Parallel(); the
// first parallel test added here makes this a data race.
func TestNewRejectsADeviceItCannotBuild(t *testing.T) {
	// Only the stable prefix is asserted: the known-device list that follows grows
	// the moment a second entry ships.
	assertPanicsWith(t, `unknown device "no-such-device"; known devices:`, func() {
		New(Config{Device: Device{Name: "no-such-device"}})
	})

	registry["unavailable-test-device"] = Device{
		Name:           "unavailable-test-device",
		Toolchain:      "amdgcn",
		TargetArch:     "gfx000",
		Label:          "A device this build cannot run",
		DisabledReason: "the pinned MGPUSim checkout has no platform for it",
	}
	t.Cleanup(func() { delete(registry, "unavailable-test-device") })

	assertPanicsWith(t, "not available: the pinned MGPUSim checkout has no platform for it", func() {
		New(Config{Device: Device{Name: "unavailable-test-device"}})
	})
}

// assertPanicsWith requires fn to panic and requires the message to contain
// want, so a test cannot pass by panicking for an unrelated reason.
func assertPanicsWith(t *testing.T, want string, fn func()) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatalf("New did not panic; want a message containing %q", want)
		}
		message, ok := recovered.(string)
		if !ok {
			t.Fatalf("New panicked with %T (%v), want a string message", recovered, recovered)
		}
		if !strings.Contains(message, want) {
			t.Errorf("panic message %q does not contain %q", message, want)
		}
	}()
	fn()
}

// TestDeviceTelemetryAgreesWithTheBuild is the test for the drift this type
// exists to prevent: the metrics must name the device that was built.
func TestDeviceTelemetryAgreesWithTheBuild(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}
	manifest := loadManifest(t)
	fixture := fixtureByID(t, manifest, "ldsconflict")
	_, codeObject := loadFixtureByID(t, manifest, "ldsconflict")
	device := DefaultDevice()

	h := New(withLDS(Config{
		MaxInst: 2_000_000,
		Device:  device,
	}))
	h.LoadCodeObject(codeObject)

	// The LDS analyzer records into a package-level global and h.Drain() does not
	// empty it, so this test has to drain the analysis or it hands its patterns to
	// whichever test drains next.
	t.Cleanup(func() { h.LDSAnalysis() })

	// OTLPMetrics returns an empty request until a kernel has run (otel.go:41
	// guards on lastKernelName).
	recipe := fixture.UniformLaunch
	pointers := make([]uint64, recipe.PointerArgs)
	for index := range pointers {
		pointers[index] = h.Malloc(recipe.Elements * 4)
	}
	for index := 0; index < recipe.H2DBuffers; index++ {
		values := make([]float32, recipe.Elements)
		h.MemcpyH2D(pointers[index], f32Bytes(values))
	}
	h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
		KernelArgs{Pointers: pointers, Uint32s: recipe.U32Args})
	h.Drain()

	if got := h.DeviceName(); got != device.Name {
		t.Errorf("the harness reports device %q but was built for %q", got, device.Name)
	}
	// Read the resource attribute off the OTLP request, the only place the name is
	// published.
	var found string
	for _, resourceMetrics := range h.OTLPMetrics().ResourceMetrics {
		for _, attribute := range resourceMetrics.Resource.GetAttributes() {
			if attribute.GetKey() == "hipy.simulator.gpu" {
				found = attribute.GetValue().GetStringValue()
			}
		}
	}
	if found != device.Name {
		t.Errorf("the hipy.simulator.gpu attribute says %q but the device is %q: "+
			"the metrics disagree with what was built", found, device.Name)
	}

}

// TestToolchainRegistryAgrees is the cross-file check that makes the
// device -> toolchain -> arch mapping a mapping rather than two tables. This package
// decides what MGPUSim builds and toolchain/toolchains.json decides what the
// compiler emits, and nothing at run time joins them.
//
// Direction matters: a device here the JSON does not claim is one the browser
// cannot compile, and one the JSON claims that this registry lacks is a stranger
// failure, so both are checked.
func TestToolchainRegistryAgrees(t *testing.T) {
	for _, device := range Devices() {
		toolchainID, arch, err := toolchainArch(device.Name)
		if err != nil {
			t.Errorf("device %q: %v", device.Name, err)
			continue
		}
		if toolchainID != device.Toolchain {
			t.Errorf("device %q is on toolchain %q here and %q in toolchains.json",
				device.Name, device.Toolchain, toolchainID)
		}
		if arch != device.TargetArch {
			t.Errorf("device %q targets %q here and %q in toolchains.json",
				device.Name, device.TargetArch, arch)
		}
	}
}

// The other direction: toolchains.json must not name a device this package lacks.
func TestEveryClaimedDeviceIsBuildable(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "toolchain", "toolchains.json"))
	if err != nil {
		t.Fatalf("read toolchains.json: %v", err)
	}
	var registryFile toolchainRegistry
	if err := json.Unmarshal(raw, &registryFile); err != nil {
		t.Fatalf("parse toolchains.json: %v", err)
	}
	known := map[string]bool{}
	for _, device := range Devices() {
		known[device.Name] = true
	}
	for _, toolchain := range registryFile.Toolchains {
		for device := range toolchain.Devices {
			if !known[device] {
				t.Errorf("toolchains.json claims device %q under %q, which this simulator cannot build",
					device, toolchain.ID)
			}
		}
	}
}
