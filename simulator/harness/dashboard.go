package harness

import "fmt"

// How the browser derives a value series. A fourth kind is a change here and in
// website/src/lib/dashboard.ts together, not in a panel.
const (
	// The field as it stands, one point per sample.
	kindValue = "value"
	// Consecutive samples differenced over the simulated time between them, in
	// GB/s. The one kind that is a difference, since the simulator accumulates
	// counters rather than measuring rates.
	kindRate = "rate"
	// A byte count in MiB, one point per sample, so the number on the axis is
	// one a reader can hold.
	kindBytes = "bytes"
)

// A chart on its own row. The default.
const layoutFull = "full"

// A chart beside the next paired one.
const layoutPair = "pair"

// Series hues: a name, not a colour. An SVG presentation attribute cannot take a
// custom property, so the four values are spelled out beside the --chart-* tokens
// in the panel. Read and write are opposites a reader must tell apart; occupancy
// and memory never appear beside one another.
// kernelTrafficPath is where the sample keeps one entry per kernel, named here so
// the schema and the sample cannot drift on it.
const kernelTrafficPath = "kernelTraffic"

const (
	hueRead   = "read"
	hueWrite  = "write"
	hueShare  = "share"
	hueMemory = "memory"
)

// SeriesSchema is one line on a chart.
//
// Path is dot-separated into a sample ("memLevels.L2.readSinceLaunchBytes")
// rather than a field name, because the hierarchy's fields live in a map keyed by
// the device's own cache levels.
type SeriesSchema struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
	Hue   string `json:"hue"`
}

// ReferenceSchema is a flat line at a known ceiling, drawn from the newest
// sample: a series of counts has no natural top, so without it the axis is scaled
// to the data's own peak and a reader cannot see how much room is left.
type ReferenceSchema struct {
	Path  string `json:"path"`
	Label string `json:"label"`
}

// WarnSchema marks a figure worth warning about: vramUsedBytes at 90% of
// vramCapacityBytes, which the shape of the line does not show.
type WarnSchema struct {
	Path         string  `json:"path"`
	CapacityPath string  `json:"capacityPath"`
	AtLeast      float64 `json:"atLeast"`
}

// ChartSchema is one chart: a heading, a set of series, and the units.
//
// Note is a template over the newest sample rather than a string, because the
// current figure belongs in the heading: a y axis carries a scale and not a
// value.
type ChartSchema struct {
	ID        string           `json:"id"`
	Eyebrow   string           `json:"eyebrow"`
	Title     string           `json:"title"`
	Layout    string           `json:"layout"`
	ValueKind string           `json:"valueKind"`
	XUnit     string           `json:"xUnit"`
	YUnit     string           `json:"yUnit"`
	Series    []SeriesSchema   `json:"series"`
	Note      string           `json:"note,omitempty"`
	Empty     string           `json:"empty,omitempty"`
	Reference *ReferenceSchema `json:"reference,omitempty"`
	Warn      *WarnSchema      `json:"warn,omitempty"`

	// This chart's per-kernel breakdown, absent on a chart that has none. The schema
	// is read before any kernel runs, so it declares the pattern, not the kernels.
	KernelSeries *KernelSeriesSchema `json:"kernelSeries,omitempty"`
}

// KernelSeriesSchema is how to read one kernel's share of a level's traffic. The paths
// are templates with %d for the kernel's index, which cannot change meaning because
// nothing is ever removed from that array.
type KernelSeriesSchema struct {
	ReadPath  string `json:"readPath"`
	WritePath string `json:"writePath"`
}

// HierarchyRow is one level of the memory hierarchy: its label and the two paths
// its traffic arrives on.
//
// No "present" flag: a level this device lacks has no sample entry for its path,
// and an unresolvable path renders as "not present", a claim about what has been
// measured rather than about traffic.
type HierarchyRow struct {
	Label     string `json:"label"`
	ReadPath  string `json:"readPath"`
	WritePath string `json:"writePath"`
}

// HierarchySchema is the strip of per-level traffic, innermost first. It exists
// because "DRAM read throughput is flat" has two causes the DRAM row cannot tell
// apart: the kernel barely read, or it read plenty and none of it reached DRAM.
type HierarchySchema struct {
	Eyebrow string         `json:"eyebrow"`
	Note    string         `json:"note"`
	Rows    []HierarchyRow `json:"rows"`
}

// MeterEntry is one hit rate and the sample path it is read from.
type MeterEntry struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

// MetersSchema is the hit-rate grid: meters rather than charts, because a hit rate
// converges on one value and has no shape over time to draw.
type MetersSchema struct {
	Eyebrow string       `json:"eyebrow"`
	Title   string       `json:"title"`
	Note    string       `json:"note"`
	Entries []MeterEntry `json:"entries"`
}

// DashboardSchema is the dashboard, as the device that measured it describes it.
// Every figure in it is a device fact -- which levels exist, how many lanes, what
// "since launch" means -- so a list of them written in the website would be a
// guess about hardware in the wrong layer.
//
// Every figure is TO DATE, not instantaneous: the simulator accumulates counters,
// so a hit rate mid-run is the ratio of two monotonic counts so far and converges
// on its final value. The one thing that IS a rate is traffic, differenced by the
// browser, which is why ValueKind names "rate" rather than a field.
type DashboardSchema struct {
	Title          string          `json:"title"`
	RunningEyebrow string          `json:"runningEyebrow"`
	FinalEyebrow   string          `json:"finalEyebrow"`
	RunningBadge   string          `json:"runningBadge"`
	FinalBadge     string          `json:"finalBadge"`
	Badge          string          `json:"badge"`
	Hierarchy      HierarchySchema `json:"hierarchy"`
	Charts         []ChartSchema   `json:"charts"`
	Meters         MetersSchema    `json:"meters"`
	Footer         string          `json:"footer"`
}

// DashboardSchema describes how this harness's live stream should be drawn, read
// off the built platform rather than off the device's name, so a device that gains
// or loses a level needs no change here.
func (h *Harness) DashboardSchema() DashboardSchema {
	levels := builtMemLevels(h.sim)

	charts := make([]ChartSchema, 0, len(levels)+4)
	// DRAM first, then one chart per level above it, so the strip reads downward
	// the same way the charts do.
	charts = append(charts, h.dramChart())
	for _, level := range levels {
		charts = append(charts, levelChart(level))
	}
	charts = append(charts,
		occupancyChart("lanes", "Active lanes", "SIMD lanes executing", "activeSimds", "totalSimds", "lanes"),
		occupancyChart("cus", "Active compute units", "Compute units executing", "activeCus", "totalCus", "CUs"),
		vramChart(),
	)

	rows := make([]HierarchyRow, 0, len(levels)+1)
	for _, level := range levels {
		rows = append(rows, HierarchyRow{
			Label:     level,
			ReadPath:  fmt.Sprintf("memLevels.%s.readSinceLaunchBytes", level),
			WritePath: fmt.Sprintf("memLevels.%s.writeSinceLaunchBytes", level),
		})
	}
	// DRAM is appended rather than being one of the levels above, because it is
	// the one level measured by its own tracers and present on every device.
	rows = append(rows, HierarchyRow{
		Label:     "DRAM",
		ReadPath:  "dramReadSinceLaunchBytes",
		WritePath: "dramWriteSinceLaunchBytes",
	})

	entries := make([]MeterEntry, 0, len(h.cacheLabels())+1)
	for _, label := range h.cacheLabels() {
		entries = append(entries, MeterEntry{Label: label, Path: "cacheHitRate." + label})
	}
	entries = append(entries, MeterEntry{Label: "TLB", Path: "tlbHitRate"})

	return DashboardSchema{
		Title:          "Live GPU metrics",
		RunningEyebrow: "Running now",
		FinalEyebrow:   "How the run went",
		RunningBadge:   "live",
		FinalBadge:     "final",
		Badge:          "{elapsedSinceLaunchPs:duration} since launch",
		Hierarchy: HierarchySchema{
			Eyebrow: "Memory hierarchy",
			Note:    "request bytes since launch, per level",
			Rows:    rows,
		},
		Charts: charts,
		Meters: MetersSchema{
			Eyebrow: "Cache hit rates",
			Title:   "To date, not instantaneous",
			Note:    "A rate here is the ratio of two counters so far, so it converges rather than fluctuates",
			Entries: entries,
		},
		// Since-launch, like every other figure here. The absolute pair carries the
		// copies and memsets ahead of the launch, which are DRAM writes the kernel
		// never issued, so the footer would disagree with the strip and the chart.
		Footer: "{dramReadSinceLaunchBytes:bytes} read and {dramWriteSinceLaunchBytes:bytes} written " +
			"over {instructions:count} instructions in {waves:count} wavefronts.",
	}
}

// dramChart is the traffic chart for the bottom of the hierarchy. The note carries
// totals rather than a rate: a rate at one instant is a difference between two
// samples, while the total answers how much traffic this kernel moved.
func (h *Harness) dramChart() ChartSchema {
	return trafficChart("dram", "DRAM traffic", "", "DRAM", "dramReadSinceLaunchBytes", "dramWriteSinceLaunchBytes")
}

// levelChart is the same chart for one cache level, named in both the eyebrow and
// the series so two levels on screen are distinguishable.
func levelChart(level string) ChartSchema {
	return trafficChart(
		"throughput-"+level,
		level+" traffic",
		level,
		level,
		fmt.Sprintf("memLevels.%s.readSinceLaunchBytes", level),
		fmt.Sprintf("memLevels.%s.writeSinceLaunchBytes", level),
	)
}

// trafficChart is the traffic chart for one level. kernelLevel is that level's key
// in the per-kernel breakdown, empty meaning DRAM -- which is not a cache level and
// so has its own key on the sample rather than an index into the level set.
func trafficChart(id, eyebrow, level, kernelLevel, readPath, writePath string) ChartSchema {
	readLabel, writeLabel := "reads", "writes"
	if level != "" {
		readLabel, writeLabel = level+" reads", level+" writes"
	} else {
		readLabel, writeLabel = "DRAM reads", "DRAM writes"
	}
	chart := ChartSchema{
		ID:        id,
		Eyebrow:   eyebrow,
		Title:     "Throughput, against simulated time",
		Layout:    layoutFull,
		ValueKind: kindRate,
		XUnit:     "Simulated time",
		YUnit:     "GB/s",
		Series: []SeriesSchema{
			{ID: id + "-read", Label: readLabel, Path: readPath, Hue: hueRead},
			{ID: id + "-write", Label: writeLabel, Path: writePath, Hue: hueWrite},
		},
		KernelSeries: &KernelSeriesSchema{
			ReadPath:  fmt.Sprintf("%s.%%d.levels.%s.readBytes", kernelTrafficPath, kernelLevel),
			WritePath: fmt.Sprintf("%s.%%d.levels.%s.writeBytes", kernelTrafficPath, kernelLevel),
		},
		Note: fmt.Sprintf("{%s:bytes} read · {%s:bytes} written, since launch", readPath, writePath),
	}
	if level != "" {
		chart.Empty = fmt.Sprintf("No %s traffic between two samples yet.", level)
	} else {
		chart.Empty = "No DRAM traffic between two samples yet."
	}
	return chart
}

// occupancyChart is one of the two COUNT charts, drawn against the device's own
// ceiling. A count rather than a percentage: a percentage is bounded at 100, so
// it cannot show that one device has 256 lanes and another 64.
func occupancyChart(id, eyebrow, title, activePath, totalPath, unit string) ChartSchema {
	return ChartSchema{
		ID:        id,
		Eyebrow:   eyebrow,
		Title:     title,
		Layout:    layoutPair,
		ValueKind: kindValue,
		XUnit:     "Simulated time",
		YUnit:     unit,
		Series: []SeriesSchema{
			{ID: id, Label: eyebrow, Path: activePath, Hue: hueShare},
		},
		Note:      fmt.Sprintf("{%s:count} of {%s:count} now", activePath, totalPath),
		Empty:     fmt.Sprintf("No %s sampled yet.", eyebrow),
		Reference: &ReferenceSchema{Path: totalPath, Label: unit},
	}
}

// vramChart is device memory in use, as a chart rather than a meter: every
// allocation happens before the first launch, so a bar showing only "now" shows
// nothing at all, while the flatness is visible as a series.
func vramChart() ChartSchema {
	return ChartSchema{
		ID:        "vram",
		Eyebrow:   "Device memory",
		Title:     "Host allocations",
		Layout:    layoutFull,
		ValueKind: kindBytes,
		XUnit:     "Simulated time",
		YUnit:     "MiB",
		Series: []SeriesSchema{
			{ID: "vram", Label: "Allocated", Path: "vramUsedBytes", Hue: hueMemory},
		},
		Note:  "{vramUsedBytes:memory/vramCapacityBytes}",
		Empty: "No device memory allocated yet.",
		Warn:  &WarnSchema{Path: "vramUsedBytes", CapacityPath: "vramCapacityBytes", AtLeast: 0.9},
	}
}

// cacheLabels is the cache LEVELS this build hooked, deduplicated and in the
// order the platform registered them.
//
// From the tracers rather than a fixed list, for the reason memLevelNames is not
// one: the device registry says which GPUs exist, not what a given build produced.
// collectCaches is not used because it drops a level that has seen no traffic, and
// this is the SCHEMA -- the panel decides what to leave out, by asking the samples.
func (h *Harness) cacheLabels() []string {
	var labels []string
	seen := map[string]bool{}
	for _, entry := range h.hooks.caches {
		label := cacheLabel(entry.cache.Name())
		if seen[label] {
			continue
		}
		seen[label] = true
		labels = append(labels, label)
	}
	return labels
}
