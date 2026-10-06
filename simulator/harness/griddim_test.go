package harness

import (
	"testing"
)

// gridDimProbeSlotFloats mirrors gridDimProbeSlotFloats in
// testdata/griddim.cu: per work group, the probe writes gridDim.x/y/z, then
// blockDim.x/y/z, then blockIdx.x/y/z.
const gridDimProbeSlotFloats = 12

// TestGridDimMatchesLaunchGeometry pins gridDim, and the blockDim and blockIdx that
// share its launch, across 1D, 2D and 3D multi-work-group launches.
//
// gridDim is not an SGPR on gfx803: clang lowers `gridDim.x` to
// `s_load_dword s0, s[4:5], 0xc`, a load of AAMDQ packet offset 12 through the
// dispatch-pointer SGPR pair. It needs the kernel_code_properties dispatch-pointer
// bit set (amd/timing/cu/wfdispatcher.go writes the packet address into s[4:5] only
// then) and the packet's grid_size fields, which every AMDGPU launcher fills with
// total work items rather than the work-group count CUDA's gridDim means.
func TestGridDimMatchesLaunchGeometry(t *testing.T) {
	if testing.Short() {
		t.Skip("cycle-accurate sim is slow")
	}
	manifest := loadManifest(t)
	fixture, codeObject := loadFixtureByID(t, manifest, "griddim")

	cases := []struct {
		name  string
		grid  [3]uint32
		block [3]uint32
	}{
		{name: "1d", grid: [3]uint32{4, 1, 1}, block: [3]uint32{64, 1, 1}},
		{name: "2d", grid: [3]uint32{2, 2, 1}, block: [3]uint32{16, 4, 1}},
		{name: "3d", grid: [3]uint32{3, 4, 2}, block: [3]uint32{8, 4, 2}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			workGroups := tc.grid[0] * tc.grid[1] * tc.grid[2]
			slots := int(workGroups) * gridDimProbeSlotFloats

			h := New(withLDS(Config{MaxInst: 2_000_000}))
			h.LoadCodeObject(codeObject)
			out := h.Malloc(slots * 4)
			h.MemcpyH2D(out, make([]byte, slots*4))

			// The harness takes MGPUSim's grid convention, which counts total
			// work items; the probe's own gridDim is what is under test.
			total := [3]uint32{tc.grid[0] * tc.block[0], tc.grid[1] * tc.block[1], tc.grid[2] * tc.block[2]}
			h.LaunchKernel(fixture.Kernel, total, tc.block,
				KernelArgs{Pointers: []uint64{out}})
			h.Drain()

			got := fromBytes(h.MemcpyD2H(out, slots*4))
			for b := uint32(0); b < workGroups; b++ {
				slot := got[b*gridDimProbeSlotFloats:]
				wantBlockIdx := [3]float32{
					float32(b % tc.grid[0]),
					float32((b / tc.grid[0]) % tc.grid[1]),
					float32(b / (tc.grid[0] * tc.grid[1])),
				}
				want := [9]float32{
					float32(tc.grid[0]), float32(tc.grid[1]), float32(tc.grid[2]),
					float32(tc.block[0]), float32(tc.block[1]), float32(tc.block[2]),
					wantBlockIdx[0], wantBlockIdx[1], wantBlockIdx[2],
				}
				for i, w := range want {
					if slot[i] != w {
						t.Fatalf("work group %d slot %d = %v, want %v "+
							"(grid %v block %v; got %v)", b, i, slot[i], w,
							tc.grid, tc.block, got[b*gridDimProbeSlotFloats:])
					}
				}
			}
		})
	}
}
