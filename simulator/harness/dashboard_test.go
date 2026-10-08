package harness

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// A field the panel reads and the schema does not set is a blank heading, and a
// level the schema invents for a device that has none is a row of zeros that reads
// as a measurement. These assert the shape against the platform actually built.

// chartByID finds a chart in the schema, failing the test when it is absent.
func chartByID(t *testing.T, s DashboardSchema, id string) ChartSchema {
	t.Helper()
	for _, chart := range s.Charts {
		if chart.ID == id {
			return chart
		}
	}
	t.Fatalf("the schema has no chart %q; it has %v", id, chartIDs(s))
	return ChartSchema{}
}

func chartIDs(s DashboardSchema) []string {
	ids := make([]string, 0, len(s.Charts))
	for _, chart := range s.Charts {
		ids = append(ids, chart.ID)
	}
	return ids
}

func TestTheSchemaDescribesTheLevelsTheDeviceBuilt(t *testing.T) {
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

		schema := h.DashboardSchema()

		// The levels this build has, plus DRAM, which every device has and which
		// is measured by its own tracers rather than being a cache level.
		wantRows := append(append([]string{}, tc.want...), "DRAM")
		gotRows := make([]string, 0, len(schema.Hierarchy.Rows))
		for _, row := range schema.Hierarchy.Rows {
			gotRows = append(gotRows, row.Label)
		}
		if !slices.Equal(gotRows, wantRows) {
			t.Errorf("%s hierarchy rows = %v, want %v", tc.device, gotRows, wantRows)
		}

		// One traffic chart per level above DRAM, plus the four the panel always
		// draws: the chart list is derived, so it follows the build.
		for _, level := range tc.want {
			chart := chartByID(t, schema, "throughput-"+level)
			if len(chart.Series) != 2 {
				t.Errorf("%s: the %s chart has %d series, want a read and a write", tc.device, level, len(chart.Series))
			}
		}
		if _, found := findChart(schema, "throughput-MALL"); found != slices.Contains(tc.want, "MALL") {
			t.Errorf("%s has a MALL chart: %v, want one only when the level exists (%v)",
				tc.device, found, tc.want)
		}
		for _, id := range []string{"dram", "lanes", "cus", "vram"} {
			chartByID(t, schema, id)
		}
		if got, want := len(schema.Charts), len(tc.want)+4; got != want {
			t.Errorf("%s has %d charts (%v), want %d", tc.device, got, chartIDs(schema), want)
		}
	}
}

func findChart(s DashboardSchema, id string) (ChartSchema, bool) {
	for _, chart := range s.Charts {
		if chart.ID == id {
			return chart, true
		}
	}
	return ChartSchema{}, false
}

// Paths are strings, so nothing else would catch a typo in one.
func TestEverySeriesPathResolvesAgainstARealSample(t *testing.T) {
	device, err := LookupDevice("cdna3generic")
	if err != nil {
		t.Fatalf("LookupDevice: %v", err)
	}
	h := New(Config{Device: device, MaxInst: 1})
	t.Cleanup(h.Close)

	schema := h.DashboardSchema()
	sample := h.sampleMetrics()

	for _, chart := range schema.Charts {
		for _, series := range chart.Series {
			if !pathResolves(sample, series.Path) {
				t.Errorf("chart %q series %q names path %q, which no sample field matches", chart.ID, series.ID, series.Path)
			}
		}
		if chart.Reference != nil && !pathResolves(sample, chart.Reference.Path) {
			t.Errorf("chart %q references %q, which no sample field matches", chart.ID, chart.Reference.Path)
		}
		if chart.Warn != nil && (!pathResolves(sample, chart.Warn.Path) || !pathResolves(sample, chart.Warn.CapacityPath)) {
			t.Errorf("chart %q warns on %q/%q, which no sample field matches",
				chart.ID, chart.Warn.Path, chart.Warn.CapacityPath)
		}
		for _, row := range schema.Hierarchy.Rows {
			if !pathResolves(sample, row.ReadPath) || !pathResolves(sample, row.WritePath) {
				t.Errorf("hierarchy row %q names %q/%q, which no sample field matches",
					row.Label, row.ReadPath, row.WritePath)
			}
		}
	}
	for _, entry := range schema.Meters.Entries {
		// A cache level resolves only once it has seen a transaction, which a
		// platform with no traffic may not have. The TLB is a top-level field.
		if entry.Label == "TLB" && !pathResolves(sample, entry.Path) {
			t.Errorf("the TLB meter names %q, which no sample field matches", entry.Path)
		}
	}
}

// pathResolves mirrors the browser: walk a dotted path through a decoded sample and
// require a number at the end. It reads the sample back through JSON so a field
// that exists only as a Go struct tag is caught here.
func pathResolves(sample Metrics, path string) bool {
	raw, err := json.Marshal(sample)
	if err != nil {
		return false
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return false
	}
	cursor := decoded
	for _, key := range strings.Split(path, ".") {
		// A numeric segment indexes an array, which is how a kernel's entry is
		// reached: the array is keyed by position because the schema is read before
		// any kernel has run and so cannot name them.
		if list, ok := cursor.([]any); ok {
			index, err := strconv.Atoi(key)
			if err != nil || index < 0 || index >= len(list) {
				return false
			}
			cursor = list[index]
			continue
		}
		object, ok := cursor.(map[string]any)
		if !ok {
			return false
		}
		cursor, ok = object[key]
		if !ok {
			return false
		}
	}
	_, ok := cursor.(float64)
	return ok
}

// The derived figure the badge asks for is computed in the browser, so it is
// asserted on the rendered note rather than on any sample field.
func TestTheSchemaNamesOnlyDerivedFiguresItMeans(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	schema := h.DashboardSchema()
	if !strings.Contains(schema.Badge, "elapsedSinceLaunchPs:duration") {
		t.Errorf("the badge is %q, which does not read the elapsed-since-launch figure", schema.Badge)
	}
	// The panel takes no launch clock of its own because the raw engine clock reads
	// high before the kernel has done anything: the H2D copies tick it.
	if pathResolves(h.sampleMetrics(), "elapsedSinceLaunchPs") {
		t.Error("elapsedSinceLaunchPs is a derived figure, but a sample field carries it")
	}
}

// A note template naming a field the schema does not send renders as its own token
// text in a reader's heading. Formats are the browser's, so only the path half is
// checked.
func TestEveryNoteTemplateNamesFieldsTheSampleCarries(t *testing.T) {
	device, err := LookupDevice("gcn3generic")
	if err != nil {
		t.Fatalf("LookupDevice: %v", err)
	}
	h := New(Config{Device: device, MaxInst: 1})
	t.Cleanup(h.Close)

	schema := h.DashboardSchema()
	templates := map[string]string{"badge": schema.Badge, "footer": schema.Footer}
	for _, chart := range schema.Charts {
		templates["chart "+chart.ID] = chart.Note
	}

	for name, template := range templates {
		for _, token := range noteTokens(template) {
			path, _, ok := strings.Cut(token, ":")
			if path == "elapsedSinceLaunchPs" {
				continue // derived; see TestTheSchemaNamesOnlyDerivedFiguresItMeans
			}
			if !ok {
				t.Errorf("%s: the token %q has no format, so it is rendered as a bare number", name, token)
			}
			if !pathResolves(h.sampleMetrics(), path) {
				t.Errorf("%s: the token %q names path %q, which no sample field matches", name, token, path)
			}
		}
	}
}

// noteTokens is the token half of the note syntax: the text inside each {...}.
// Duplicated because the syntax is a contract between the two sides, and the
// assertion is that Go emits only what website/src/lib/dashboard.ts renders.
func noteTokens(template string) []string {
	var tokens []string
	rest := template
	for {
		open := strings.Index(rest, "{")
		if open == -1 {
			return tokens
		}
		close := strings.Index(rest[open:], "}")
		if close == -1 {
			return tokens
		}
		tokens = append(tokens, rest[open+1:open+close])
		rest = rest[open+close+1:]
	}
}

// The reference line is read off the sample rather than written into the schema, so
// the two cannot drift into a ceiling the axis is not scaled to.
func TestReferencesAndWarningsNameFieldsTheSampleCarries(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	schema := h.DashboardSchema()
	lanes := chartByID(t, schema, "lanes")
	if lanes.Reference == nil || lanes.Reference.Path != "totalSimds" {
		t.Errorf("the lanes chart references %+v, want totalSimds", lanes.Reference)
	}
	if lanes.Reference != nil && lanes.Reference.Label != "lanes" {
		t.Errorf("the lanes reference is labelled %q, want a unit the axis already repeats", lanes.Reference.Label)
	}
	cus := chartByID(t, schema, "cus")
	if cus.Reference == nil || cus.Reference.Path != "totalCus" {
		t.Errorf("the CU chart references %+v, want totalCus", cus.Reference)
	}
	vram := chartByID(t, schema, "vram")
	if vram.Warn == nil || vram.Warn.Path != "vramUsedBytes" || vram.Warn.CapacityPath != "vramCapacityBytes" {
		t.Errorf("the VRAM chart warns on %+v, want the used/capacity pair", vram.Warn)
	}
}

// The strip's byte columns are to-date totals, never since-launch figures.
func TestTheStripRowsAreToDateTotals(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	schema := h.DashboardSchema()

	for _, row := range schema.Hierarchy.Rows {
		for _, path := range []string{row.ReadPath, row.WritePath} {
			if strings.Contains(path, "SinceLaunch") {
				t.Errorf("hierarchy row %q reads %q, which resets at every launch; the strip "+
					"is a table of to-date totals", row.Label, path)
			}
		}
	}

	// Name the rows too: one resolving to neither path would pass above and print
	// nothing.
	wantRowPaths := map[string][2]string{}
	for _, level := range builtMemLevels(h.sim) {
		wantRowPaths[level] = [2]string{
			fmt.Sprintf("memLevels.%s.readBytes", level),
			fmt.Sprintf("memLevels.%s.writeBytes", level),
		}
	}
	wantRowPaths["DRAM"] = [2]string{"dramReadBytes", "dramWriteBytes"}
	for _, row := range schema.Hierarchy.Rows {
		want, known := wantRowPaths[row.Label]
		if !known {
			t.Errorf("hierarchy row %q is not a level this build has", row.Label)
			continue
		}
		if row.ReadPath != want[0] || row.WritePath != want[1] {
			t.Errorf("hierarchy row %q reads %q/%q, want %q/%q",
				row.Label, row.ReadPath, row.WritePath, want[0], want[1])
		}
	}
}

// The footer and the DRAM row are two renderings of one figure, so they must read the
// same fields. The strip is to-date, so the footer is too.
func TestTheFooterAndTheDRAMRowReadTheSameFields(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	schema := h.DashboardSchema()
	var row HierarchyRow
	for _, candidate := range schema.Hierarchy.Rows {
		if candidate.Label == "DRAM" {
			row = candidate
		}
	}
	if row.Label != "DRAM" {
		t.Fatal("the hierarchy has no DRAM row")
	}

	tokens := map[string]string{}
	for _, token := range noteTokens(schema.Footer) {
		path, _, _ := strings.Cut(token, ":")
		tokens[path] = token
	}
	for _, path := range []string{row.ReadPath, row.WritePath} {
		if _, named := tokens[path]; !named {
			t.Errorf("the footer does not read %q, which is the DRAM row's own field: %q",
				path, schema.Footer)
		}
	}
	// A per-launch figure resets, so it must stay out of a to-date footer.
	for _, perLaunch := range []string{"dramReadSinceLaunchBytes", "dramWriteSinceLaunchBytes"} {
		if _, named := tokens[perLaunch]; named {
			t.Errorf("the footer reads %q, which resets at every launch while the strip "+
				"beside it is a to-date total: %q", perLaunch, schema.Footer)
		}
	}
}

// The charts keep the per-launch figures, since they are drawn against time.
func TestTheTrafficChartsStayPerLaunch(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	schema := h.DashboardSchema()
	chart, found := findChart(schema, "dram")
	if !found {
		t.Fatal("the schema has no DRAM chart")
	}
	for _, series := range chart.Series {
		if !strings.Contains(series.Path, "SinceLaunch") {
			t.Errorf("DRAM chart series %q reads %q, a to-date total; the chart is drawn "+
				"against time and segments per launch", series.ID, series.Path)
		}
	}
}

// The panel interprets valueKind and nothing else, and a new kind is a change on
// both sides.
func TestEveryChartDeclaresAKindAndUnitTheBrowserImplements(t *testing.T) {
	for _, device := range Devices() {
		h := New(Config{Device: device, MaxInst: 1})
		t.Cleanup(h.Close)

		for _, chart := range h.DashboardSchema().Charts {
			switch chart.ValueKind {
			case kindValue, kindRate, kindBytes:
			default:
				t.Errorf("%s: chart %q declares valueKind %q, which the panel does not implement",
					device.Name, chart.ID, chart.ValueKind)
			}
			if chart.YUnit == "" || chart.XUnit == "" {
				t.Errorf("%s: chart %q is missing a unit (%q, %q)", device.Name, chart.ID, chart.XUnit, chart.YUnit)
			}
			if chart.Eyebrow == "" || chart.Title == "" {
				t.Errorf("%s: chart %q is missing a heading", device.Name, chart.ID)
			}
			if chart.Note == "" {
				t.Errorf("%s: chart %q has no heading figure", device.Name, chart.ID)
			}
		}
	}
}

// A rate chart's points are INTERVALS, and the panel can only produce one by
// differencing a cumulative byte counter. Only that direction is asserted: a rate
// over anything else would put a difference of levels on an axis labelled GB/s and
// the chart would still draw. A bytes-kind chart may plot a byte count the panel
// does not difference -- device memory goes DOWN on a free.
func TestOnlyCumulativeByteCountersAreDifferenced(t *testing.T) {
	for _, device := range Devices() {
		h := New(Config{Device: device, MaxInst: 1})
		t.Cleanup(h.Close)

		for _, chart := range h.DashboardSchema().Charts {
			if chart.ValueKind != kindRate {
				continue
			}
			for _, series := range chart.Series {
				// A Transaction field is a count, not a byte count, and a level is
				// neither.
				cumulative := strings.Contains(series.Path, "Bytes") &&
					!strings.Contains(series.Path, "Transactions")
				if !cumulative {
					t.Errorf("%s: chart %q series %q is a rate over %q, which is not a cumulative byte counter",
						device.Name, chart.ID, series.ID, series.Path)
				}
			}
		}
	}
}

// A field the panel needs but that json drops -- an empty slice, a nil map -- would
// be a chart with no series.
func TestTheSchemaIsReadableAsJSON(t *testing.T) {
	h := New(Config{MaxInst: 1})
	t.Cleanup(h.Close)

	raw, err := json.Marshal(h.DashboardSchema())
	if err != nil {
		t.Fatalf("marshal the schema: %v", err)
	}
	var decoded DashboardSchema
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("the schema does not read back as one: %v", err)
	}
	if len(decoded.Charts) == 0 || len(decoded.Meters.Entries) == 0 || len(decoded.Hierarchy.Rows) == 0 {
		t.Fatalf("the marshalled schema lost content: %d charts, %d meters, %d rows",
			len(decoded.Charts), len(decoded.Meters.Entries), len(decoded.Hierarchy.Rows))
	}
	for _, chart := range decoded.Charts {
		if len(chart.Series) == 0 {
			t.Errorf("chart %q marshalled with no series", chart.ID)
		}
	}
}
