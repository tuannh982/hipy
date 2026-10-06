//go:build !js || !wasm

// Command lds-telemetry runs one uniform fixture and writes its raw OTLP metrics
// to stdout as a JSON object.
//
// It exists for the MGPUSim patch A/B in harness/ldsbank_patchab_test.go, which must
// run the same workload from a patched and an unpatched build. Go compiles ahead of
// time, so the two sides cannot be the same binary, and this program is the half
// that must build in both.
//
// The build constraint is load-bearing: the unpatched side has no amd/ldsbank
// package, so nothing in this build may import it. That is why the analyzer reaches
// harness as a Config.LDSDrain value and the wire types live in the leaf package
// ldswire.
//
// It deliberately does NOT set LDSDrain, so the report is empty: the telemetry shape
// a pre-patch simulator produced. The comparison is therefore about everything the
// simulator simulates, since the recording path is inside the simulator and runs in
// the patched build regardless.
//
// Output is raw, not normalized: internal/otlpcmp owns the one copy of that.
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"

	metricv1 "go.opentelemetry.io/proto/otlp/metrics/v1"

	"hipy/simulator/harness"
)

type launchSpec struct {
	Elements    int       `json:"elements"`
	Grid        [3]uint32 `json:"grid"`
	Block       [3]uint32 `json:"block"`
	PointerArgs int       `json:"pointerArgs"`
	U32Args     []uint32  `json:"u32Args"`
	H2DBuffers  int       `json:"h2dBuffers"`
}

type fixtureSpec struct {
	ID            string      `json:"id"`
	Kernel        string      `json:"kernel"`
	CodeObject    string      `json:"codeObject"`
	UniformLaunch *launchSpec `json:"uniformLaunch"`
}

type manifest struct {
	Version  int           `json:"version"`
	Fixtures []fixtureSpec `json:"fixtures"`
}

// dump is the JSON object written to stdout. The members are raw JSON because the
// OTLP protobuf types carry oneof fields that encoding/json cannot round-trip, and
// the consumer feeds the bytes straight to the normalizer anyway.
type dump struct {
	Metrics json.RawMessage `json:"metrics"`
}

func main() {
	fixtureID := flag.String("fixture", "ldsconflict", "id of the uniformLaunch fixture to run")
	manifestPath := flag.String("manifest", filepath.Join("testdata", "fixtures.json"),
		"path to the fixture manifest")
	maxInst := flag.Int("max-inst", 2_000_000, "instruction limit")
	flag.Parse()

	raw, err := os.ReadFile(*manifestPath)
	if err != nil {
		fail("read manifest: %v", err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		fail("parse manifest: %v", err)
	}

	fixture := findUniform(m, *fixtureID)
	if fixture == nil {
		fail("fixture %q has no uniformLaunch recipe; manifest declares %v", *fixtureID, declared(m))
	}

	codeObject, err := os.ReadFile(filepath.Join(filepath.Dir(*manifestPath), fixture.CodeObject))
	if err != nil {
		fail("read codeObject for %s: %v", fixture.ID, err)
	}

	out := run(*fixture, codeObject, harness.Config{MaxInst: *maxInst})
	if len(out.Metrics) == 0 {
		fail("the run produced %d bytes of metrics; a comparison over nothing "+
			"would pass without having checked anything", len(out.Metrics))
	}

	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fail("encode dump: %v", err)
	}
}

// run performs the launch, filling buffers the way the harness tests do: a[i] = i
// in the first H2D buffer and b[i] = 2i+1 in the rest. The equivalent helper in
// package harness lives in a _test.go file; duplicating it here keeps fixture
// knowledge out of library code.
func run(fixture fixtureSpec, codeObject []byte, cfg harness.Config) dump {
	recipe := fixture.UniformLaunch
	h := harness.New(cfg)
	h.LoadCodeObject(codeObject)

	pointers := make([]uint64, recipe.PointerArgs)
	for i := range pointers {
		pointers[i] = h.Malloc(recipe.Elements * 4)
	}
	for i := 0; i < recipe.H2DBuffers; i++ {
		values := make([]float32, recipe.Elements)
		for j := range values {
			if i == 0 {
				values[j] = float32(j)
			} else {
				values[j] = float32(2*j + 1)
			}
		}
		h.MemcpyH2D(pointers[i], f32Bytes(values))
	}

	h.LaunchKernel(fixture.Kernel, recipe.Grid, recipe.Block,
		harness.KernelArgs{Pointers: pointers, Uint32s: recipe.U32Args})
	h.Drain()

	metrics, err := json.Marshal(allMetrics(h.OTLPMetrics().ResourceMetrics))
	if err != nil {
		fail("marshal metrics: %v", err)
	}

	return dump{Metrics: metrics}
}

func findUniform(m manifest, id string) *fixtureSpec {
	for i := range m.Fixtures {
		if m.Fixtures[i].ID == id && m.Fixtures[i].UniformLaunch != nil {
			return &m.Fixtures[i]
		}
	}
	return nil
}

func declared(m manifest) []string {
	ids := make([]string, 0, len(m.Fixtures))
	for i := range m.Fixtures {
		ids = append(ids, m.Fixtures[i].ID)
	}
	sort.Strings(ids)
	return ids
}

func f32Bytes(values []float32) []byte {
	out := make([]byte, len(values)*4)
	for i, v := range values {
		binary.LittleEndian.PutUint32(out[i*4:], math.Float32bits(v))
	}
	return out
}

func allMetrics(resourceMetrics []*metricv1.ResourceMetrics) []*metricv1.Metric {
	var out []*metricv1.Metric
	for _, rm := range resourceMetrics {
		for _, sm := range rm.ScopeMetrics {
			out = append(out, sm.Metrics...)
		}
	}
	return out
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "lds-telemetry: "+format+"\n", args...)
	os.Exit(1)
}
