package harness

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"hipy/simulator/internal/otlpcmp"
)

// TestLDSBankPatchIsInert is the with/without-patch proof the design promises:
// the same workload, run from a build of the pinned MGPUSim with
// third_party/mgpusim_patches/001-ldsbank-analyzer.patch applied and from a
// build without it, must
// report byte-identical telemetry once wall-clock noise is normalized away.
//
// The two inertness tests in ldsbank_inert_test.go cannot substantiate this: both of
// their runs come from one binary, so both contain the patch.
//
// This cannot run in-process: Go compiles ahead of time, so reversing the patch on
// disk does not change what an already-compiled test binary contains. That is why
// the A/B shells out to cmd/lds-telemetry, which must build against either tree.
//
// The build invariant that makes that work is that no file in the lds-telemetry build
// imports amd/ldsbank, which is a property of the whole import graph, so it is
// CHECKED in TestTelemetryBuildReachesNoAnalyzer and again below on the
// reverse-applied tree.
//
// Opt-in, because it mutates the MGPUSim checkout on disk:
//
//	LDS_PATCH_AB=1 go test ./harness/ -run TestLDSBankPatchIsInert -count=1 -v
func TestLDSBankPatchIsInert(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}
	if os.Getenv("LDS_PATCH_AB") != "1" {
		t.Skip("set LDS_PATCH_AB=1 to run: this reverses the ldsbank patch on disk " +
			"and rebuilds the simulator twice")
	}

	moduleRoot, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("resolve module root: %v", err)
	}
	mgpusim := filepath.Join(moduleRoot, "third_party", "mgpusim")
	// Only the analyzer is reversed. The gcn3 patch is not optional -- without it
	// nothing compiles into a runnable platform -- so it stays applied on both sides
	// and the A/B is analyzer-present against analyzer-absent, which is the question.
	patch := filepath.Join(moduleRoot, "third_party", "mgpusim_patches", "001-ldsbank-analyzer.patch")

	if _, err := os.Stat(mgpusim); err != nil {
		t.Fatalf("mgpusim checkout: %v (run `make -C simulator deps` first)", err)
	}
	// The tree must start from a *patched* checkout, so what has to hold up front is
	// that the patch reverse-applies.
	if out, err := git(mgpusim, "apply", "-R", "--check", patch); err != nil {
		t.Fatalf("%s does not reverse-apply to third_party/mgpusim, so this test "+
			"cannot produce an A/B. The checkout is not in the patched state the "+
			"committed patch describes; restore it with `make -C simulator "+
			"deps`: %v\n%s", patch, err, out)
	}

	restorer := newPatchRestorer(t, mgpusim, patch)
	defer restorer.run()

	// The patched side first, while the tree is in the state the caller found it, so a
	// hard failure partway through leaves the tree as it was.
	patched := runTelemetrySide(t, moduleRoot)

	if out, err := git(mgpusim, "apply", "-R", "--check", patch); err != nil {
		t.Fatalf("the ldsbank patch stopped reverse-applying partway through the "+
			"test, so the checkout has drifted underneath it: %v\n%s", err, out)
	}
	if out, err := git(mgpusim, "apply", "-R", patch); err != nil {
		t.Fatalf("reverse-apply the ldsbank patch: %v\n%s", err, out)
	}
	restorer.markReversed()

	// The build invariant, checked on the tree that has just lost the patch and
	// before anything expensive runs.
	assertTelemetryBuildResolves(t, moduleRoot)

	bare := runTelemetrySide(t, moduleRoot)

	restorer.reapply()

	if patched == bare {
		return
	}
	// Any simulated difference is a failure of the observation-only claim, so the
	// message names the claim rather than guessing the mechanism.
	t.Fatalf("telemetry differs between a patched and an unpatched MGPUSim, so the "+
		"patch is not observation-only: applying it changes what the simulator "+
		"reports. First difference at offset %d\npatched %s\nbare    %s",
		firstDifference(patched, bare),
		excerptAround(patched, bare), excerptAround(bare, patched))
}

// runTelemetrySide builds and runs cmd/lds-telemetry against whatever state the
// MGPUSim checkout is currently in, and returns its telemetry normalized.
func runTelemetrySide(t *testing.T, moduleRoot string) string {
	t.Helper()

	cmd := exec.Command("go", "run", "./cmd/lds-telemetry", "-fixture", "ldsconflict")
	cmd.Dir = moduleRoot
	// Output is captured rather than streamed so that a failed build reports its
	// own stderr in the test failure. The cost is that both sides run silently
	// until this returns, which on a cold build cache is a couple of minutes.
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("go run ./cmd/lds-telemetry: %v\n%s", err, stderr.String())
	}

	// The members are raw JSON, not typed values: lds-telemetry marshals the OTLP
	// payloads and nothing can unmarshal them back, because the protobuf types
	// carry oneof fields encoding/json does not round-trip. The bytes go straight
	// to the normalizer, which only ever treats them as text.
	var d struct {
		Metrics json.RawMessage `json:"metrics"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &d); err != nil {
		t.Fatalf("decode lds-telemetry output: %v\nfirst 400 bytes: %.400s", err, stdout.String())
	}
	if len(d.Metrics) == 0 {
		t.Fatalf("lds-telemetry produced %d bytes of metrics; a comparison over "+
			"nothing would pass without having checked anything", len(d.Metrics))
	}

	return otlpcmp.Metrics(d.Metrics)
}

// patchRestorer puts the MGPUSim checkout back the way it found it. Restoration runs
// on the normal path, on a failed comparison, and from a defer for a panic or an
// os.Exit, and a failure to restore is reported as a test failure of its own.
type patchRestorer struct {
	t       *testing.T
	mgpusim string
	patch   string

	// baseline is the porcelain status the checkout presented on entry.
	baseline string

	// reversed records that markReversed has been called, the only state in which
	// there is anything to put back.
	reversed bool
}

func newPatchRestorer(t *testing.T, mgpusim, patch string) *patchRestorer {
	t.Helper()
	return &patchRestorer{
		t:        t,
		mgpusim:  mgpusim,
		patch:    patch,
		baseline: strings.Join(gitStatus(mgpusim), "\n"),
	}
}

func (r *patchRestorer) markReversed() { r.reversed = true }

// run is the deferred safety net. Safe to call when nothing was reversed.
func (r *patchRestorer) run() { r.reapply() }

// reapply puts the patch back and checks the tree is byte-identical to how the
// test found it, rather than merely "not obviously broken". Idempotent: a second
// call is a no-op.
func (r *patchRestorer) reapply() {
	if !r.reversed {
		return
	}
	r.reversed = false

	if out, err := git(r.mgpusim, "apply", "--check", r.patch); err != nil {
		r.fail(err, out)
		return
	}
	if out, err := git(r.mgpusim, "apply", r.patch); err != nil {
		r.fail(err, out)
		return
	}

	if after := strings.Join(gitStatus(r.mgpusim), "\n"); after != r.baseline {
		r.t.Errorf("third_party/mgpusim was not restored to its pre-test state.\n"+
			"before:\n%s\n\nafter:\n%s\n\nRecover with `make -C simulator deps`",
			r.baseline, after)
	}
}

// fail reports a restoration failure. The instruction is `make deps` rather than
// a re-apply because fetch-deps.sh already knows how to get from any state to a
// correctly patched checkout at the pinned commit.
func (r *patchRestorer) fail(err error, out string) {
	r.t.Errorf("could not re-apply %s, so third_party/mgpusim is left unpatched and "+
		"every later build in this repo would link against bare MGPUSIM_COMMIT.\n"+
		"Recover with `make -C simulator deps`.\n%v\n%s", r.patch, err, out)
}

func gitStatus(dir string) []string {
	out, err := git(dir, "status", "--porcelain")
	if err != nil {
		return []string{"<git status failed: " + err.Error() + ">"}
	}
	return strings.Split(strings.TrimRight(out, "\n"), "\n")
}

func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return strings.TrimSpace(stdout.String() + "\n" + stderr.String()), err
	}
	return strings.TrimSpace(stdout.String()), nil
}
