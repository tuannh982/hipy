package harness

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// analyzerPackage is the import path third_party/mgpusim_patches/001 adds. It exists
// in a patched MGPUSim tree and in no other, which is what makes it the one package
// in this module's build that cannot be reached from a host program.
const analyzerPackage = "github.com/sarchlab/mgpusim/v5/amd/ldsbank"

// The A/B in ldsbank_patchab_test.go has to build cmd/lds-telemetry twice: once
// against a patched MGPUSim and once against a bare checkout of the pinned commit,
// where the analyzer package does not exist. So nothing on the path to that program
// may import it. A claim a build depends on cannot be left to prose.
func TestOnlyTheLDSConverterImportsTheAnalyzer(t *testing.T) {
	assertOnlyTheConverterImportsTheAnalyzer(t, moduleRoot(t))
}

// assertOnlyTheConverterImportsTheAnalyzer asks go list for each package's DIRECT
// imports rather than for the transitive closure of one of them. On a patched tree
// the analyzer is in harness's transitive closure regardless (the patch's own hunk
// in MGPUSim's amd/timing/cu/ldsunit.go imports it), so "does the build reach the
// analyzer" is unanswerable there. What has to hold is that no file here imports it.
//
// wasmexec is listed separately under GOOS=js: its files are all behind
// //go:build js && wasm, so a native `go list ./...` does not see it.
func assertOnlyTheConverterImportsTheAnalyzer(t *testing.T, root string) {
	t.Helper()

	found := map[string]bool{}
	for _, listing := range moduleImportList(t, root) {
		pkg, imports, ok := strings.Cut(listing, "|")
		if !ok {
			t.Fatalf("unreadable go list line %q", listing)
		}
		for _, imported := range strings.Split(imports, ",") {
			if imported == analyzerPackage {
				found[pkg] = true
			}
		}
	}

	want := []string{"hipy/simulator/internal/ldsanalysis"}
	got := make([]string, 0, len(found))
	for pkg := range found {
		got = append(got, pkg)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("the packages importing %s are %v, want exactly %v.\n"+
			"The analyzer reaches a host program only through Config.LDSDrain, so "+
			"that package -- which the unpatched side of the A/B cannot resolve -- "+
			"must not be on the path to cmd/lds-telemetry. The wire types belong in "+
			"package ldswire and the conversion in internal/ldsanalysis; see the "+
			"package doc in ldswire for the full argument.",
			analyzerPackage, got, want)
	}
}

// moduleImportList returns "importpath|comma,separated,direct,imports" for every
// package in the module, one per line. Both listings are the whole module, so a
// package added later is covered by being added rather than by being remembered.
func moduleImportList(t *testing.T, root string) []string {
	t.Helper()

	const format = `{{.ImportPath}}|{{join .Imports ","}}`
	var lines []string
	for _, target := range []struct{ env, pkg string }{
		{"", "./..."},
		{"GOOS=js GOARCH=wasm", "./wasmexec"},
	} {
		cmd := exec.Command("go", "list", "-f", format, target.pkg)
		cmd.Dir = root
		if target.env != "" {
			cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm")
		}
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			t.Fatalf("go list %s (env %q): %v\n%s", target.pkg, target.env, err, stderr.String())
		}
		lines = append(lines, strings.Split(strings.TrimRight(stdout.String(), "\n"), "\n")...)
	}
	return lines
}

// assertTelemetryBuildResolves is the A/B's own precondition, checked on the tree
// that has just lost the patch. On an unpatched tree the analyzer does not exist, so
// a build that reached it would not resolve; the whole check is whether go list
// succeeds. The message says what the failure almost always means, because the raw
// error names a package and nothing about which file asked for it.
func assertTelemetryBuildResolves(t *testing.T, root string) {
	t.Helper()

	cmd := exec.Command("go", "list", "-deps", "./cmd/lds-telemetry")
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if _, err := cmd.Output(); err != nil {
		t.Fatalf("the lds-telemetry build does not resolve against the unpatched "+
			"MGPUSim tree, so that side of the A/B cannot run: %v\n%s\n"+
			"The usual cause is a NON-TEST file in that build importing %s, which a "+
			"bare checkout of the pinned commit does not have. The wire types "+
			"belong in package ldswire, the conversion in internal/ldsanalysis, and "+
			"harness must take its drain from Config.LDSDrain rather than an import. "+
			"TestOnlyTheLDSConverterImportsTheAnalyzer checks that on the patched tree.",
			err, stderr.String(), analyzerPackage)
	}
}

// moduleRoot is the directory holding go.mod, which is the working directory every
// go command in these tests needs. This is the one place that is decided.
func moduleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("resolve module root: %v", err)
	}
	return root
}
