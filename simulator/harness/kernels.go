package harness

// Per-kernel traffic: what each kernel moved, summed over every launch of it. The
// sample's own figures are the CURRENT launch's, so a file with two kernels otherwise
// reports one number for the pair and the second kernel owns all of it.
//
// One entry per distinct kernel name, first-launched order. Nothing is removed or
// reordered, because the panel addresses an entry by its index.

// KernelLevelSample is one level's traffic for one kernel.
type KernelLevelSample struct {
	ReadBytes  uint64 `json:"readBytes"`
	WriteBytes uint64 `json:"writeBytes"`
}

// KernelTraffic is one kernel's traffic across every launch of it. Levels is keyed as
// MemLevels is, plus "DRAM"; a level the device lacks is absent rather than zero.
type KernelTraffic struct {
	Kernel   string `json:"kernel"`
	Launches int    `json:"launches"`
	// The window it ran in. The panel plots the cumulative figure, so the curve's
	// shape says this rather than the panel having to be told.
	FirstSimTimePs uint64                       `json:"firstSimTimePs"`
	LastSimTimePs  uint64                       `json:"lastSimTimePs"`
	Levels         map[string]KernelLevelSample `json:"levels"`
}

// Attribution happens on every OBSERVATION, not only at launch boundaries: the
// traffic since the last one belongs to whichever kernel is in flight, so a kernel's
// figure rises while it runs and the chart draws a hill over the window it occupied.
// Attributing only at the next launch would post all of it to the instant after the
// kernel finished, which is a spike at the end and no hill.
//
// A launch is therefore also charged its own kernarg segment and AQL packet, a few KiB
// the host writes on its way past. That is the honest split: the bookkeeping was caused
// by that kernel.

// attributePendingTraffic charges the launch in flight. This is the entry point the
// engine goroutine uses, so that pendingKernel is read under the lock rather than by
// the caller.
func (h *Harness) attributePendingTraffic() {
	h.kernelMu.Lock()
	defer h.kernelMu.Unlock()
	h.attributeTrafficLocked(h.pendingKernel)
}

// attributeTrafficLocked charges entryIndex for everything the counters have moved
// since the last observation, then takes that as the new baseline. A negative index is
// a no-op: nothing was in flight, so the traffic belongs to no kernel.
func (h *Harness) attributeTrafficLocked(entryIndex int) {
	dram := h.collectDRAM()
	cache := h.collectCacheBytes()

	if entryIndex >= 0 && entryIndex < len(h.kernelTraffic) {
		entry := &h.kernelTraffic[entryIndex]
		addLevelTraffic(entry.Levels, "DRAM",
			saturatingSub(dram.readBytes, h.observedDRAM.readBytes),
			saturatingSub(dram.writeBytes, h.observedDRAM.writeBytes))
		for level := 0; level < memLevelCount; level++ {
			if !h.hasMemLevel(level) {
				continue
			}
			addLevelTraffic(entry.Levels, memLevelNames[level],
				saturatingSub(cache[level].readBytes, h.observedCache[level].readBytes),
				saturatingSub(cache[level].writeBytes, h.observedCache[level].writeBytes))
		}
	}

	h.observedDRAM = dram
	h.observedCache = cache
}

// beginKernelLaunch makes name the pending kernel, retiring the one it replaces.
func (h *Harness) beginKernelLaunch(name string, simTimePs uint64) {
	h.kernelMu.Lock()
	defer h.kernelMu.Unlock()
	h.retireKernelLaunchLocked(simTimePs)

	index, seen := h.kernelIndex[name]
	if !seen {
		index = len(h.kernelTraffic)
		h.kernelIndex[name] = index
		h.kernelTraffic = append(h.kernelTraffic, KernelTraffic{
			Kernel:         name,
			Levels:         map[string]KernelLevelSample{},
			FirstSimTimePs: simTimePs,
		})
	}

	h.kernelTraffic[index].LastSimTimePs = simTimePs
	h.pendingKernel = index
}

// closeKernelLaunch retires the last launch, which a drain is the first moment to see
// finished. One function retires both kinds of end: a launch boundary retires the one
// it replaces, and this retires the last, and counting only one of them loses every
// launch the other kind covers.
func (h *Harness) closeKernelLaunch(simTimePs uint64) {
	h.kernelMu.Lock()
	defer h.kernelMu.Unlock()
	h.retireKernelLaunchLocked(simTimePs)
}

func (h *Harness) retireKernelLaunchLocked(simTimePs uint64) {
	h.attributeTrafficLocked(h.pendingKernel)

	if h.pendingKernel >= 0 && h.pendingKernel < len(h.kernelTraffic) {
		entry := &h.kernelTraffic[h.pendingKernel]
		entry.Launches++
		entry.LastSimTimePs = simTimePs
		h.kernelTrafficDirty = true
	}
	h.pendingKernel = -1
}

// addLevelTraffic accumulates into an entry, leaving a level the device does not have
// absent rather than present-and-zero.
func addLevelTraffic(levels map[string]KernelLevelSample, level string, read, write uint64) {
	current := levels[level]
	current.ReadBytes += read
	current.WriteBytes += write
	levels[level] = current
}

// kernelTrafficSnapshot is what the sample carries: a copy, because the entry's Levels
// map is written in place.
func (h *Harness) kernelTrafficSnapshot() []KernelTraffic {
	h.kernelMu.Lock()
	defer h.kernelMu.Unlock()
	if len(h.kernelTraffic) == 0 {
		return nil
	}
	out := make([]KernelTraffic, 0, len(h.kernelTraffic))
	for _, entry := range h.kernelTraffic {
		levels := make(map[string]KernelLevelSample, len(entry.Levels))
		for level, sample := range entry.Levels {
			levels[level] = sample
		}
		entry.Levels = levels
		out = append(out, entry)
	}
	return out
}
