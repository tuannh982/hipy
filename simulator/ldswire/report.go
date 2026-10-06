// Package ldswire is the LDS bank-conflict wire contract: the plain-JSON body the
// LDS tab is built from. It is a leaf package and imports nothing, because the
// analyzer that fills it does not exist in a bare checkout of the pinned MGPUSim
// commit and the patch A/B must compile harness against either tree. harness
// re-exports these as aliases, so the JSON is byte-identical.
package ldswire

// NumBanks is the width of the LDS bank row on gfx803, and the length of
// LdsPhase.BankAddrs. internal/ldsanalysis compile-time checks it against the
// analyzer's own width.
const NumBanks = 32

// Drain reads the bank analyzer once and returns the report the LDS tab renders plus
// the index the timeline joins spans against. A function value because a drain is one
// destructive read and the only thing a host decides is whether to link an analyzer.
type Drain func() (LdsAnalysisReport, map[uint64]LdsInst)

// LdsInst is what one LDS instruction execution contributes to the timeline. The
// exec-unit name alone cannot tell a read from a write, so the timeline needs the
// analyzer's opcode to label the span.
type LdsInst struct {
	// Found distinguishes a real entry from a lookup miss: the zero LdsInst's
	// Degree is 0, which is neither a real degree (the analyzer floors them at 1)
	// nor the -1 sentinel, and rendered as a band it claims a conflict.
	Found bool

	Read bool

	// Degree is the pattern's conflict degree, at least 1 when Found is set.
	Degree int

	// Pattern indexes LdsAnalysisReport.Patterns, so a caller can reach the row
	// that justifies Degree and Read.
	Pattern int
}

// LdsPhase is one hardware phase of a representative access, as the UI draws it.
type LdsPhase struct {
	FirstLane int   `json:"firstLane"`
	LastLane  int   `json:"lastLane"`
	Lanes     []int `json:"lanes"`
	Degree    int   `json:"degree"`

	// BankAddrs is how many distinct addresses each bank saw in this phase, indexed
	// by bank. Distinct addresses, not lanes: a broadcast puts 64 lanes on one
	// address in bank 0, so this reports 1 where a lane count would report a 64-way
	// conflict. A bank is conflicted exactly when its entry exceeds 1.
	BankAddrs [NumBanks]int `json:"bankAddrs"`
}

// LdsLane is one lane's placement in the bank map. Only active lanes appear, so
// Bank is always a real bank index (the analyzer's -1 for inactive lanes does not
// survive the trip into this type).
type LdsLane struct {
	Lane int `json:"lane"`

	// Bank is (byte address / 4) mod 32, the GCN3 rule. Always >= 0.
	Bank int `json:"bank"`

	// Phase indexes Phases. It is -1 only for an active lane matching no phase's
	// lane range, which a hand-built Analysis handed to ldsbank.Record could.
	Phase int `json:"phase"`
}

// LdsPattern is one distinct access pattern, plus how often it ran.
type LdsPattern struct {
	PC     uint64 `json:"pc"`
	Name   string `json:"name"`
	IsRead bool   `json:"isRead"`
	Degree int    `json:"degree"`

	// Stride is the byte step between consecutive lanes in the first phase, the
	// headline diagnostic because it is what the reader can change.
	Stride int `json:"stride"`

	// UniformStride reports whether the first phase steps uniformly, like Stride:
	// first-phase scope only, because the per-phase values are in Phases.
	UniformStride bool `json:"uniformStride"`

	// Approximate marks the two parts of the model that are inferred rather than
	// sourced: the b128-read phase grouping, and sub-word granularity. The UI must
	// surface these rather than presenting the degree as measured.
	PhaseModelApproximate         bool `json:"phaseModelApproximate"`
	AddressGranularityApproximate bool `json:"addressGranularityApproximate"`

	Phases []LdsPhase `json:"phases"`
	Lanes  []LdsLane  `json:"lanes"`

	// RepIsFirstSeen is always true: the grouping key's degree vector is coarse
	// enough that a group can hold executions with different per-lane addresses, so
	// this bank map is the first-seen member, not a summary.
	RepIsFirstSeen bool `json:"repIsFirstSeen"`

	Count uint64 `json:"count"`

	// Instances are the instruction task IDs this pattern ran under, the join back
	// to the wavefront trace. The analyzer clips the list at its own cap while
	// keeping Count exact, so len(Instances) can fall well below Count;
	// InstancesTruncated says so.
	Instances []uint64 `json:"instances"`

	// InstancesTruncated reports that Instances is shorter than Count.
	InstancesTruncated bool `json:"instancesTruncated"`
}

// LdsStats is what the drain had to leave behind. DroppedExecutions counts
// executions, not patterns; TruncatedInstances counts dropped list entries, not
// dropped executions, and a report must keep the two apart.
type LdsStats struct {
	Patterns           uint64 `json:"patterns"`
	DroppedExecutions  uint64 `json:"droppedExecutions"`
	TruncatedInstances uint64 `json:"truncatedInstances"`
}

// LdsAnalysisReport is the third telemetry body. Plain JSON rather than OTLP-shaped:
// per-lane addresses are bulk data, and it is not forwarded to a collector.
type LdsAnalysisReport struct {
	Patterns []LdsPattern `json:"patterns"`
	Stats    LdsStats     `json:"stats"`
}
