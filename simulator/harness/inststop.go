package harness

import (
	"fmt"
	"os"

	"github.com/sarchlab/akita/v5/tracing"
)

// instStopper counts retired "inst" tasks and invokes the cutoff hook once
// maxCount have retired. The default hook prints to stderr and exits 3; tests
// inject Config.StopOnMaxInst instead, which must not os.Exit.
//
// No locks: the serial engine calls all tracing hooks from one goroutine.
type instStopper struct {
	tracing.NopTracer

	count     uint64
	maxCount  uint64
	onCutoff  func()
	didCutOff bool
	inflight  map[uint64]tracing.TaskStart
}

func newInstStopper(maxInst uint64, onCutoff func()) *instStopper {
	if onCutoff == nil {
		onCutoff = func() {
			fmt.Fprintf(os.Stderr,
				"harness: inst cutoff reached (%d instructions retired)\n",
				maxInst)
			os.Exit(3)
		}
	}
	return &instStopper{
		maxCount: maxInst,
		onCutoff: onCutoff,
		inflight: map[uint64]tracing.TaskStart{},
	}
}

func (s *instStopper) StartTask(task tracing.TaskStart) {
	if task.Kind != "inst" {
		return
	}
	s.inflight[task.ID] = task
}

func (s *instStopper) EndTask(task tracing.TaskEnd) {
	if _, found := s.inflight[task.ID]; !found {
		return
	}
	delete(s.inflight, task.ID)

	s.count++
	if s.maxCount > 0 && s.count >= s.maxCount && !s.didCutOff {
		s.didCutOff = true
		s.onCutoff()
	}
}
