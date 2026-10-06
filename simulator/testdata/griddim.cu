#include <cuda_runtime.h>

// gridDimProbeSlotFloats is the per-work-group output stride: gridDim.x/y/z,
// then blockDim.x/y/z, then blockIdx.x/y/z.
enum { gridDimProbeSlotFloats = 12 };

// gridDim probe.
//
// Every work group writes twelve floats into its own slot of `out`, enumerated in
// x-major order over the grid: the gridDim, blockDim and blockIdx it observed, so a
// test that knows the launch shape can check all three from every work group.
//
// Branch-free per work item, because MGPUSim splits a wavefront at every branch and
// a split changes which lanes reach the stores. Only lane (0,0,0) writes the
// blockDim/blockIdx tail, so the other 63 must not disturb it.
//
// It reads blockDim as well, because both come from the same launch: blockDim is a
// 16-bit load from the COV5 hidden-argument block and gridDim comes out of the AAMDQ
// dispatch packet, so gridDim.x * blockDim.x must be the total work items in x.
extern "C" __global__ void gridDimProbe(float *out) {
    const unsigned int wg =
        (blockIdx.z * gridDim.y + blockIdx.y) * gridDim.x + blockIdx.x;
    float *slot = out + wg * gridDimProbeSlotFloats;

    slot[0] = (float)gridDim.x;
    slot[1] = (float)gridDim.y;
    slot[2] = (float)gridDim.z;
    if (threadIdx.x == 0 && threadIdx.y == 0 && threadIdx.z == 0) {
        slot[3] = (float)blockDim.x;
        slot[4] = (float)blockDim.y;
        slot[5] = (float)blockDim.z;
        slot[6] = (float)blockIdx.x;
        slot[7] = (float)blockIdx.y;
        slot[8] = (float)blockIdx.z;
    }
}

int main() {
    // Launch geometry for the standalone run: 4 x 2 x 2 work groups of
    // 16 x 4 x 1 threads. TestGridDimMatchesLaunchGeometry drives the same
    // shape through the harness, plus 1D and 3D shapes.
    const dim3 grid(4, 2, 2);
    const dim3 block(16, 4, 1);
    const unsigned int workGroups = 4 * 2 * 2;
    float out[workGroups * gridDimProbeSlotFloats];
    float *deviceOut;

    cudaMalloc(&deviceOut, sizeof(out));
    cudaMemset(deviceOut, 0, sizeof(out));

    gridDimProbe<<<grid, block>>>(deviceOut);
    cudaGetLastError();
    cudaDeviceSynchronize();

    cudaMemcpy(out, deviceOut, sizeof(out), cudaMemcpyDeviceToHost);
    for (unsigned int wg = 0; wg < workGroups; wg++) {
        const float *slot = &out[wg * gridDimProbeSlotFloats];
        printf("wg %u: gridDim = (%.1f, %.1f, %.1f), blockDim = "
               "(%.1f, %.1f, %.1f), blockIdx = (%.1f, %.1f, %.1f)\n",
               wg, slot[0], slot[1], slot[2], slot[3], slot[4], slot[5],
               slot[6], slot[7], slot[8]);
    }

    cudaFree(deviceOut);
    return 0;
}
