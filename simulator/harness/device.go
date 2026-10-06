package harness

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/sarchlab/akita/v5/mem"
)

// Device names a simulated GPU, and is the single source of truth for both
// what MGPUSim builds and what the telemetry claims.
type Device struct {
	// Name is the registry key.
	Name string

	// Toolchain is the id of the compiler toolchain that must emit for this
	// device, and it is a row in toolchain/toolchains.json. A toolchain is a
	// driver wasm plus clang flags plus an ISA family, so a second vendor is a
	// second row there rather than a branch in the compile path. Nothing resolves
	// it here; only agreement is checked (TestToolchainRegistryAgrees).
	Toolchain string

	// TargetArch is the ISA the toolchain must emit for this device: the gfx name
	// today. There is deliberately no default, because a code object built for
	// one ISA loads on a platform of another without complaint (machID is not
	// range-checked, parseV5KernelDescriptor in amd/insts/hsaco.go).
	TargetArch string

	// SimulatorType is the name MGPUSim's timingconfig builder switches on, and
	// it is deliberately not this device's Name. createGPUBuilder
	// (timingconfig/builder.go:294) has one case, "mi300x", and a default branch
	// at builder.go:328 that builds an r9nano for anything else, so passing this
	// device's own key would build a GCN3 platform under a CDNA3 name silently.
	// device_test.go asserts every entry names a type the builder knows.
	SimulatorType string

	// Label is the human-readable name the UI shows.
	Label string

	// MemoryBytes is how much device memory this device's model has, and it is
	// applied rather than only reported: New passes it to timingconfig's
	// WithGPUMemSize, so it is the figure the device allocator enforces.
	//
	// Modelled capacity, deliberately far below the hardware the timing models
	// come from: 16 MiB against the R9 Nano's 4 GiB, 32 MiB against the MI300X's
	// 192 GiB. At realistic sizes every shipped example reads as a fraction of a
	// percent and the limit looks unreachable; at these sizes an allocator can
	// reach the ceiling and be refused. Zero is refused by New rather than built.
	MemoryBytes uint64

	// DisabledReason is empty for a runnable device and a sentence saying what
	// is absent for one that is not. The browser renders it disabled.
	DisabledReason string

	// HasMALL records that this part has a MALL, CDNA3's Infinity Cache between
	// L2 and DRAM, so a MALL size override is meaningful for it.
	//
	// In the REGISTRY rather than derived from a built platform, because the size
	// checks must answer before anything is built. The catalog's MemLevels is
	// derived from the built platform and the two must agree
	// (TestRegistryMALLFlagMatchesTheBuiltPlatform).
	HasMALL bool
}

// registry is the whole set of selectable devices, named for the architectures
// they model rather than for the boards MGPUSim derives their configurations
// from.
//
// Adding an entry requires three things: a SimulatorType that
// timingconfig.Builder recognises, a toolchains.json row claiming the device
// under the toolchain named on the entry, and a nonzero MemoryBytes.
var registry = map[string]Device{
	"gcn3generic": {
		Name:          "gcn3generic",
		Label:         "AMD GCN3 Generic",
		Toolchain:     "amdgcn",
		TargetArch:    "gfx803",
		SimulatorType: "r9nano",
		MemoryBytes:   16 * mem.MB,
	},
	// CDNA3. Same toolchain and driver wasm as the GCN3 part, because gfx942 and
	// gfx803 are two -target-cpu values of one AMDGPU backend. MGPUSim emulates
	// CDNA3 through timingconfig's mi300x case, reached via SimulatorType.
	//
	// The correctness suite runs every fixture on every selectable device against
	// its CPU reference, so a regression fails CI. That covers these kernels, not
	// the opcode set or timing model.
	"cdna3generic": {
		Name:          "cdna3generic",
		Label:         "AMD CDNA3 Generic",
		Toolchain:     "amdgcn",
		TargetArch:    "gfx942",
		SimulatorType: "mi300x",
		MemoryBytes:   32 * mem.MB,
		HasMALL:       true,
	},
}

// LookupDevice resolves a registry key, or errors naming the known set. A typo
// must not quietly select the default device.
func LookupDevice(name string) (Device, error) {
	device, ok := registry[name]
	if !ok {
		return Device{}, fmt.Errorf("unknown device %q; known devices: %s",
			name, strings.Join(deviceNames(), ", "))
	}
	return device, nil
}

// Devices returns every entry, sorted by name, including disabled ones.
func Devices() []Device {
	all := make([]Device, 0, len(registry))
	for _, device := range registry {
		all = append(all, device)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })
	return all
}

// DefaultDevice is the device selected when the caller names none.
func DefaultDevice() Device {
	return registry["gcn3generic"]
}

func deviceNames() []string {
	all := Devices()
	names := make([]string, len(all))
	for i, device := range all {
		names[i] = device.Name
	}
	return names
}

// DeviceName is the hipy.simulator.gpu telemetry attribute.
func (h *Harness) DeviceName() string {
	return h.deviceName
}

// toolchainRegistry is the shape of toolchain/toolchains.json, as far as this
// package reads it.
type toolchainRegistry struct {
	Toolchains []struct {
		ID      string            `json:"id"`
		Devices map[string]string `json:"devices"`
	} `json:"toolchains"`
}

// toolchainArch is the toolchain id and ISA the browser's own registry names for
// one device. A separate read from the registry above on purpose: this package
// owns what MGPUSim builds, toolchains.json owns what the compiler produces, and
// only a test joins them (TestToolchainRegistryAgrees).
func toolchainArch(device string) (toolchainID, arch string, err error) {
	path := filepath.Join("..", "..", "toolchain", "toolchains.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("read %s: %w", path, err)
	}
	var registry toolchainRegistry
	if err := json.Unmarshal(raw, &registry); err != nil {
		return "", "", fmt.Errorf("parse %s: %w", path, err)
	}
	for _, toolchain := range registry.Toolchains {
		if claimed, ok := toolchain.Devices[device]; ok {
			return toolchain.ID, claimed, nil
		}
	}
	return "", "", fmt.Errorf("%s claims no device %q", path, device)
}
