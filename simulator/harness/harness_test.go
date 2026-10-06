package harness

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	metricv1 "go.opentelemetry.io/proto/otlp/metrics/v1"
)

func f32Bytes(v []float32) []byte {
	out := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(out[i*4:], math.Float32bits(f))
	}
	return out
}

func fromBytes(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out
}

type uniformLaunchSpec struct {
	Elements    int       `json:"elements"`
	Grid        [3]uint32 `json:"grid"`
	Block       [3]uint32 `json:"block"`
	PointerArgs int       `json:"pointerArgs"`
	U32Args     []uint32  `json:"u32Args"`
	H2DBuffers  int       `json:"h2dBuffers"`
}

type fixtureSpec struct {
	ID            string             `json:"id"`
	Kernel        string             `json:"kernel"`
	CodeObject    string             `json:"codeObject"`
	Source        *string            `json:"source"`
	UniformLaunch *uniformLaunchSpec `json:"uniformLaunch"`
}

type fixtureManifest struct {
	Version  int           `json:"version"`
	Fixtures []fixtureSpec `json:"fixtures"`
}

type uniformRun struct {
	h        *Harness
	pointers []uint64
}

func loadManifest(t *testing.T) fixtureManifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "fixtures.json"))
	if err != nil {
		t.Fatalf("fixture manifest: %v", err)
	}
	var manifest fixtureManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("fixture manifest parse: %v", err)
	}
	if manifest.Version != 1 {
		t.Fatalf("fixture manifest version = %d, want 1", manifest.Version)
	}
	if len(manifest.Fixtures) == 0 {
		t.Fatal("fixture manifest declares no fixtures")
	}
	return manifest
}

func loadFixtureByID(t *testing.T, manifest fixtureManifest, id string) (fixtureSpec, []byte) {
	t.Helper()
	for _, fixture := range manifest.Fixtures {
		if fixture.ID != id {
			continue
		}
		codeObject, err := os.ReadFile(filepath.Join("..", "testdata", fixture.CodeObject))
		if err != nil {
			t.Fatalf("fixture %s: %v", id, err)
		}
		return fixture, codeObject
	}
	t.Fatalf("fixture %s is not declared in the manifest", id)
	return fixtureSpec{}, nil
}

func uniformFixtures(manifest fixtureManifest) []fixtureSpec {
	var out []fixtureSpec
	for _, fixture := range manifest.Fixtures {
		if fixture.UniformLaunch != nil {
			out = append(out, fixture)
		}
	}
	return out
}

// primaryFixture returns the fixture used by the tests that care about tracing
// mechanics rather than about any particular kernel. It is vectoradd, which has no
// __shared__ traffic, so an LDS degree is never attached to its spans.
func primaryFixture(t *testing.T, manifest fixtureManifest) fixtureSpec {
	t.Helper()
	uniform := uniformFixtures(manifest)
	if len(uniform) == 0 {
		t.Fatal("no fixture declares uniformLaunch")
	}
	return uniform[0]
}

// primaryFixture returns uniform[0], which is vectoradd only because it is listed
// first. This pins that assumption so a manifest reorder is a deliberate change.
func TestManifestOrderIsTheOnePrimaryFixtureReliesOn(t *testing.T) {
	manifest := loadManifest(t)
	uniform := uniformFixtures(manifest)
	if len(uniform) == 0 {
		t.Fatal("no fixture declares uniformLaunch")
	}
	if uniform[0].ID != "vectoradd" {
		t.Fatalf("uniform[0] is %q, not vectoradd; primaryFixture's five callers "+
			"would silently switch kernels. Update primaryFixture and this test together.",
			uniform[0].ID)
	}
}

// runUniformFixtureRun loads a fixture, allocates one device buffer per pointer
// argument, fills the first H2DBuffers of them on the host (a[i] = i for the
// first, b[i] = 2i+1 for the rest), copies those H2D, launches once, and drains.
func runUniformFixtureRun(t *testing.T, fixture fixtureSpec, codeObject []byte, cfg Config) uniformRun {
	t.Helper()
	recipe := fixture.UniformLaunch
	h := New(withLDS(cfg))
	h.LoadCodeObject(codeObject)

	n := recipe.Elements
	pointers := make([]uint64, recipe.PointerArgs)
	for index := range pointers {
		pointers[index] = h.Malloc(n * 4)
	}
	for index := 0; index < recipe.H2DBuffers; index++ {
		values := make([]float32, n)
		for i := range values {
			if index == 0 {
				values[i] = float32(i)
			} else {
				values[i] = float32(2*i + 1)
			}
		}
		h.MemcpyH2D(pointers[index], f32Bytes(values))
	}

	h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
		KernelArgs{Pointers: pointers, Uint32s: recipe.U32Args})
	h.Drain()
	// The LDS bank analyzer records into a package-level global on every DS execution
	// (third_party/mgpusim/amd/timing/cu/ldsunit.go:107 gates on the emulator, never
	// on a harness setting), and h.Drain() above does not empty it: only ldsbank.Drain()
	// inside LDSAnalysis does. Without this cleanup a test that never reads the report
	// hands its patterns to whichever test drains next, which is silent and
	// order-dependent. requireRecorderEmpty is what notices.
	t.Cleanup(func() { h.LDSAnalysis() })
	return uniformRun{h: h, pointers: pointers}
}

func findMetric(name string, metrics []*metricv1.Metric) *metricv1.Metric {
	for _, metric := range metrics {
		if metric.Name == name {
			return metric
		}
	}
	return nil
}

func allMetrics(requestMetrics []*metricv1.ResourceMetrics) []*metricv1.Metric {
	var metrics []*metricv1.Metric
	for _, resourceMetrics := range requestMetrics {
		for _, scopeMetrics := range resourceMetrics.ScopeMetrics {
			metrics = append(metrics, scopeMetrics.Metrics...)
		}
	}
	return metrics
}

// TestFixtureHappyCase is the spec's happy-path harness run, executed for
// every fixture that declares a uniformLaunch recipe. A uniform fixture
// computes its last buffer elementwise as a + b.
func TestFixtureHappyCase(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}
	manifest := loadManifest(t)
	uniform := uniformFixtures(manifest)
	if len(uniform) == 0 {
		t.Fatal("no fixture declares uniformLaunch")
	}
	for _, fixture := range uniform {
		t.Run(fixture.ID, func(t *testing.T) {
			_, codeObject := loadFixtureByID(t, manifest, fixture.ID)
			run := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 2_000_000})
			recipe := fixture.UniformLaunch
			n := recipe.Elements

			a := make([]float32, n)
			b := make([]float32, n)
			for i := range a {
				a[i] = float32(i)
				b[i] = float32(2*i + 1)
			}
			output := run.pointers[len(run.pointers)-1]
			got := fromBytes(run.h.MemcpyD2H(output, n*4))
			for i := range got {
				if want := a[i] + b[i]; got[i] != want {
					t.Fatalf("c[%d] = %v, want %v", i, got[i], want)
				}
			}
		})
	}
}

// TestFixtureMetrics runs each uniform fixture and checks the collected OTLP
// metrics retain non-empty kernel timing, instructions, and waves.
func TestFixtureMetrics(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}
	manifest := loadManifest(t)
	uniform := uniformFixtures(manifest)
	if len(uniform) == 0 {
		t.Fatal("no fixture declares uniformLaunch")
	}
	for _, fixture := range uniform {
		t.Run(fixture.ID, func(t *testing.T) {
			_, codeObject := loadFixtureByID(t, manifest, fixture.ID)
			run := runUniformFixtureRun(t, fixture, codeObject, Config{MaxInst: 2_000_000})
			h := run.h
			metrics := allMetrics(h.OTLPMetrics().ResourceMetrics)
			duration := findMetric("hipy.simulator.kernel.duration", metrics)
			if duration == nil {
				t.Fatal("kernel duration metric missing")
			}
			if duration.Unit != "ns" {
				t.Errorf("kernel duration unit = %q, want ns", duration.Unit)
			}
			if len(duration.GetGauge().GetDataPoints()) != 1 {
				t.Fatalf("kernel duration points = %d, want 1", len(duration.GetGauge().GetDataPoints()))
			}
			durationNS := duration.GetGauge().GetDataPoints()[0]
			if durationNS.GetAsInt() <= 0 {
				t.Error("kernel duration is zero")
			}
			if durationNS.GetAsInt() >= 10_000_000 {
				t.Errorf("kernel duration = %d ns, want < 10_000_000 ns; unit error?", durationNS.GetAsInt())
			}

			instructions := findMetric("hipy.simulator.instructions.total", metrics)
			if instructions == nil {
				t.Fatal("total instructions metric missing")
			}
			if len(instructions.GetSum().GetDataPoints()) != 1 {
				t.Fatalf("instruction points = %d, want 1", len(instructions.GetSum().GetDataPoints()))
			}
			if instructions.GetSum().GetDataPoints()[0].GetAsInt() == 0 {
				t.Error("total instructions is zero")
			}

			waves := findMetric("hipy.simulator.waves.total", metrics)
			if waves == nil {
				t.Fatal("waves metric missing")
			}
			if len(waves.GetSum().GetDataPoints()) != 1 {
				t.Fatalf("wave points = %d, want 1", len(waves.GetSum().GetDataPoints()))
			}
			// Derive the wavefront count from the recipe rather than assuming
			// a 64-wide workgroup: work items / items per work group.
			wantWaves := int64(fixture.UniformLaunch.Grid[0] / fixture.UniformLaunch.Block[0])
			if got := waves.GetSum().GetDataPoints()[0].GetAsInt(); got != wantWaves {
				t.Errorf("waves = %d, want %d", got, wantWaves)
			}

			for _, metric := range metrics {
				for _, point := range metric.GetSum().GetDataPoints() {
					if point.StartTimeUnixNano != h.startTimeUnixNano {
						t.Errorf("%s start time = %d, want %d", metric.Name, point.StartTimeUnixNano, h.startTimeUnixNano)
					}
					if point.TimeUnixNano <= point.StartTimeUnixNano {
						t.Errorf("%s observation time %d is not after start %d", metric.Name, point.TimeUnixNano, point.StartTimeUnixNano)
					}
				}
			}
			for _, name := range []string{"hipy.simulator.cpi", "hipy.simulator.cpi.reason"} {
				metric := findMetric(name, metrics)
				if metric == nil {
					t.Errorf("%s metric missing", name)
					continue
				}
				if metric.Unit != "{cycles/instruction}" {
					t.Errorf("%s unit = %q, want {cycles/instruction}", name, metric.Unit)
				}
			}
			oversized := intDataPoint(uint64(time.Now().UnixNano()), uint64(1)<<63)
			if _, ok := oversized.Value.(*metricv1.NumberDataPoint_AsDouble); !ok {
				t.Errorf("oversized integer point value = %T, want AsDouble", oversized.Value)
			}
		})
	}
}

// TestMaxInstStopperFires verifies the MaxInst cutoff: with MaxInst=1 the stopper
// must fire on the first retired instruction. The injected StopOnMaxInst signals a
// channel and returns; it must not os.Exit under `go test`, and panicking does not
// work either because the driver's engine goroutine recovers all panics and
// terminates the process via atexit.Exit(1)
// (third_party/mgpusim/amd/driver/driver.go:130-134).
func TestMaxInstStopperFires(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}

	fired := make(chan struct{}, 1)
	h := New(withLDS(Config{
		MaxInst: 1,
		StopOnMaxInst: func() {
			select {
			case fired <- struct{}{}:
			default:
			}
		},
	}))
	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, primaryFixture(t, manifest).ID)
	recipe := fixture.UniformLaunch
	h.LoadCodeObject(codeObject)

	pointers := make([]uint64, recipe.PointerArgs)
	for index := range pointers {
		pointers[index] = h.Malloc(recipe.Elements * 4)
	}
	filled := [][]float32{make([]float32, recipe.Elements), make([]float32, recipe.Elements)}
	for i := range filled[0] {
		filled[0][i] = float32(i)
		filled[1][i] = float32(2*i + 1)
	}
	for index := 0; index < recipe.H2DBuffers && index < len(filled); index++ {
		h.MemcpyH2D(pointers[index], f32Bytes(filled[index]))
	}
	h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
		KernelArgs{Pointers: pointers, Uint32s: recipe.U32Args})
	h.Drain()

	select {
	case <-fired:
	case <-time.After(10 * time.Second):
		t.Fatal("MaxInst=1 did not fire the injected StopOnMaxInst hook")
	}
}

// packedArgBytes serializes the reflect-built kernel-argument struct that
// packArgs/packRawArgs hand to the driver, which is what binary.Write inside
// prepareLocalMemory ultimately writes into the kernarg segment. The tests
// below read it as the kernel's prologue does: raw kernarg bytes at fixed
// offsets, not the harness's own bookkeeping.
func packedArgBytes(t *testing.T, argStruct interface{}) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.LittleEndian, argStruct); err != nil {
		t.Fatalf("serialize packed kernel args: %v", err)
	}
	return buf.Bytes()
}

// alignUp8 is the COV5 hidden-block rule: the hidden argument block starts at
// the next multiple of 8 at or after the end of the explicit arguments.
func alignUp8(n int) int { return (n + 7) &^ 7 }

// TestPackRawArgsHiddenBlockFollowsExplicitArgSize pins the derived hidden block
// offset at H = align_up(len(rawArgs), 8), where clang lowers the workgroup_size
// builtins to 16-bit loads from the kernarg segment at H+12/H+14/H+16.
func TestPackRawArgsHiddenBlockFollowsExplicitArgSize(t *testing.T) {
	cases := []struct {
		name      string
		rawArgs   []byte
		grid      [3]uint32
		block     [3]uint32
		wantBlock [3]uint16
	}{
		{
			// reduction: (const float *input, float *output, int n) = 20 bytes.
			name:      "20-byte signature",
			rawArgs:   make([]byte, 20),
			grid:      [3]uint32{1024, 1, 1},
			block:     [3]uint32{64, 8, 1},
			wantBlock: [3]uint16{64, 8, 1},
		},
		{
			// (const float *a, int n) = 12 bytes: below 24, so a fixed
			// offset of 32 lands three words past the real block.
			name:      "12-byte signature",
			rawArgs:   make([]byte, 12),
			grid:      [3]uint32{256, 1, 1},
			block:     [3]uint32{32, 4, 2},
			wantBlock: [3]uint16{32, 4, 2},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Harness{}
			packed := packedArgBytes(t, h.packRawArgs(tc.rawArgs, tc.grid, tc.block, 288))
			hidden := alignUp8(len(tc.rawArgs))
			for i, want := range tc.wantBlock {
				got := binary.LittleEndian.Uint16(packed[hidden+12+2*i:])
				if got != want {
					t.Errorf("blockDim[%d] = kernarg u16 @%d = %d, want %d",
						i, hidden+12+2*i, got, want)
				}
			}
			// The block-count words the kernel reads first must also be
			// present at the derived base, not clobbered by a pad field.
			for i, want := range [3]uint32{
				tc.grid[0] / tc.block[0], tc.grid[1] / tc.block[1], tc.grid[2] / tc.block[2],
			} {
				got := binary.LittleEndian.Uint32(packed[hidden+4*i:])
				if got != want {
					t.Errorf("hidden block count[%d] = %d, want %d", i, got, want)
				}
			}
		})
	}
}

// TestPackArgsHiddenBlockFollowsExplicitArgSize is the same pin for the
// reflect-built path.
func TestPackArgsHiddenBlockFollowsExplicitArgSize(t *testing.T) {
	cases := []struct {
		name      string
		args      KernelArgs
		grid      [3]uint32
		block     [3]uint32
		wantBlock [3]uint16
	}{
		{
			name:      "vectoradd 28-byte signature",
			args:      KernelArgs{Pointers: []uint64{0x1000, 0x2000, 0x3000}, Uint32s: []uint32{1024}},
			grid:      [3]uint32{1024, 1, 1},
			block:     [3]uint32{64, 1, 1},
			wantBlock: [3]uint16{64, 1, 1},
		},
		{
			name:      "reduction 20-byte signature",
			args:      KernelArgs{Pointers: []uint64{0x1000, 0x2000}, Uint32s: []uint32{1024}},
			grid:      [3]uint32{1024, 1, 1},
			block:     [3]uint32{64, 8, 1},
			wantBlock: [3]uint16{64, 8, 1},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Harness{}
			packed := packedArgBytes(t, h.packArgs(tc.args, tc.grid, tc.block))
			explicit := 0
			for _, p := range tc.args.Pointers {
				_ = p
				explicit += 8
			}
			explicit += 4 * (len(tc.args.Uint32s) + len(tc.args.Floats))
			hidden := alignUp8(explicit)
			if hidden+hiddenBlockSize > len(packed) {
				t.Fatalf("packed args are %d bytes, too small for a hidden block at %d",
					len(packed), hidden)
			}
			for i, want := range tc.wantBlock {
				got := binary.LittleEndian.Uint16(packed[hidden+12+2*i:])
				if got != want {
					t.Errorf("blockDim[%d] = kernarg u16 @%d = %d, want %d",
						i, hidden+12+2*i, got, want)
				}
			}
		})
	}
}

func TestSAXPYRawKernelArgsPreserveDeclarationOrder(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}
	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, "saxpy")

	h := New(withLDS(Config{MaxInst: 2_000_000}))
	h.LoadCodeObject(codeObject)

	const n = 512
	x := make([]float32, n)
	y := make([]float32, n)
	for i := range x {
		x[i] = float32(i + 1)
		y[i] = 1
	}
	pX := h.Malloc(n * 4)
	pY := h.Malloc(n * 4)
	h.MemcpyH2D(pX, f32Bytes(x))
	h.MemcpyH2D(pY, f32Bytes(y))

	rawArgs := make([]byte, 28)
	binary.LittleEndian.PutUint64(rawArgs[0:8], pY)
	binary.LittleEndian.PutUint32(rawArgs[8:12], math.Float32bits(2))
	binary.LittleEndian.PutUint64(rawArgs[16:24], pX)
	binary.LittleEndian.PutUint32(rawArgs[24:28], n)
	h.LaunchKernelRaw(fixture.Kernel, [3]uint32{n, 1, 1}, [3]uint32{64, 1, 1}, rawArgs)
	h.Drain()

	got := fromBytes(h.MemcpyD2H(pY, n*4))
	if got[0] != 3 {
		t.Fatalf("y[0] = %v, want 3", got[0])
	}
}
