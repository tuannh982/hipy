package harness

import (
	"hipy/simulator/ldswire"
)

// LDS wire contract. These are aliases so that nothing here imports
// amd/ldsbank, which only exists in the patched tree; the conversion arrives as
// Config.LDSDrain. Aliasing keeps the marshalled JSON byte-identical.
type (
	LdsInst           = ldswire.LdsInst
	LdsPhase          = ldswire.LdsPhase
	LdsLane           = ldswire.LdsLane
	LdsPattern        = ldswire.LdsPattern
	LdsStats          = ldswire.LdsStats
	LdsAnalysisReport = ldswire.LdsAnalysisReport
	LDSDrain          = ldswire.Drain
)

// ldsState holds one drain's results. The guard is Harness.ldsOnce, not a
// second Once here: two would each be able to run the closure.
type ldsState struct {
	report LdsAnalysisReport
	index  map[uint64]LdsInst
}

// drainLdsbank runs the configured drain at most once and caches it. A nil
// Config.LDSDrain means this build links no analyzer -- an unpatched tree
// records nothing -- so the result is an empty report over an empty index.
// Patterns stays a non-nil empty slice because the wire contract is an array.
func (h *Harness) drainLdsbank() *ldsState {
	h.ldsOnce.Do(func() {
		// Built into a local and published last: sync.Once marks itself done
		// even if the closure panics.
		state := &ldsState{
			report: LdsAnalysisReport{Patterns: []LdsPattern{}},
			index:  make(map[uint64]LdsInst),
		}
		if h.cfg.LDSDrain != nil {
			report, index := h.cfg.LDSDrain()
			if report.Patterns == nil {
				report.Patterns = []LdsPattern{}
			}
			state.report = report
			state.index = index
		}
		h.lds = state
	})
	return h.lds
}

// LDSAnalysis returns the report the LDS tab renders. Repeated calls return the
// same value.
//
// The drain arms on first read, so call this once after the last launch or the
// earlier launches' patterns are lost. The result must not be modified: its
// slices are the cached state's.
func (h *Harness) LDSAnalysis() LdsAnalysisReport {
	return h.drainLdsbank().report
}

// ldsIndex maps an instruction task ID to what the analyzer saw for it. An absent
// key indexes to the zero LdsInst, so check Found rather than reading Degree.
func (h *Harness) ldsIndex() map[uint64]LdsInst {
	return h.drainLdsbank().index
}
