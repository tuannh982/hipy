// Package ldsanalysis converts the MGPUSim LDS bank analyzer into the wire contract
// in package ldswire. This is where the one amd/ldsbank import lives; harness must
// not reach the analyzer, because the patch A/B builds one program against both a
// patched and an unpatched tree.
package ldsanalysis

import (
	"github.com/sarchlab/mgpusim/v5/amd/ldsbank"

	"hipy/simulator/ldswire"
)

// The two bank counts must match; this index only compiles when they do.
var _ = [1]struct{}{}[ldswire.NumBanks-ldsbank.NumBanks]

// Drain reads the analyzer's recorder destructively, so harness calls it at most once
// per run; the Once lives in harness, since two would each be able to run.
func Drain() (ldswire.LdsAnalysisReport, map[uint64]ldswire.LdsInst) {
	patterns, stats := ldsbank.Drain()
	return build(patterns, stats)
}

func build(patterns []ldsbank.Pattern, stats ldsbank.Stats) (ldswire.LdsAnalysisReport, map[uint64]ldswire.LdsInst) {
	// Built into locals and returned, so a panic partway through cannot publish a
	// half-built report to the caller.
	report := ldswire.LdsAnalysisReport{
		Patterns: make([]ldswire.LdsPattern, 0),
		Stats:    ldswire.LdsStats{},
	}
	index := make(map[uint64]ldswire.LdsInst)

	report.Patterns = make([]ldswire.LdsPattern, 0, len(patterns))
	report.Stats = ldswire.LdsStats{
		Patterns:           stats.Patterns,
		DroppedExecutions:  stats.DroppedExecutions,
		TruncatedInstances: stats.TruncatedInstances,
	}

	for i, p := range patterns {
		out := ldswire.LdsPattern{
			PC:                            p.Key.PC,
			Name:                          p.Rep.Name,
			IsRead:                        p.Rep.IsRead,
			Degree:                        p.Rep.Degree,
			Stride:                        p.Rep.StrideOfFirstPhase(),
			PhaseModelApproximate:         p.Rep.PhaseModelApproximate,
			AddressGranularityApproximate: p.Rep.AddressGranularityApproximate,
			RepIsFirstSeen:                true,
			Count:                         p.Count,
			InstancesTruncated:            p.InstancesTruncated,
			Instances:                     make([]uint64, 0, len(p.Instances)),
		}
		// Analyze always emits at least one phase, but Record is exported and
		// takes an Analysis by value, so guard: an empty phase list has no
		// uniform stride to report.
		if len(p.Rep.Phases) > 0 {
			out.UniformStride = p.Rep.Phases[0].UniformStride
		}
		for _, ph := range p.Rep.Phases {
			out.Phases = append(out.Phases, ldswire.LdsPhase{
				FirstLane: ph.FirstLane,
				LastLane:  ph.LastLane,
				Lanes:     ph.Lanes,
				Degree:    ph.Degree,
				// The analyzer's own per-bank distinct-address count; Degree above is the
				// maximum of this very slice.
				BankAddrs: ph.BankAddrs,
			})
		}
		for lane, bank := range p.Rep.LaneBank {
			if bank < 0 {
				continue
			}
			phase := -1
			for pi, ph := range p.Rep.Phases {
				if lane >= ph.FirstLane && lane <= ph.LastLane {
					phase = pi
					break
				}
			}
			out.Lanes = append(out.Lanes, ldswire.LdsLane{Lane: lane, Bank: bank, Phase: phase})
		}

		for _, inst := range p.Instances {
			out.Instances = append(out.Instances, inst.InstTaskID)
			index[inst.InstTaskID] = ldswire.LdsInst{
				Found:   true,
				Read:    p.Rep.IsRead,
				Degree:  p.Rep.Degree,
				Pattern: i,
			}
		}
		// Appended last, so the copy in the report carries this pattern's instances.
		report.Patterns = append(report.Patterns, out)
	}

	return report, index
}
