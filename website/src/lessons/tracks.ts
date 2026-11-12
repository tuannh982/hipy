import type { Track } from "./types";
import { assertUniqueLessonIds } from "./lookup";
import { lesson as helloWorld } from "./gpgpu-101/1-1-hello-kernel/1-hello-world/index";
import { lesson as helloFromTheGpu } from "./gpgpu-101/1-1-hello-kernel/2-hello-from-the-gpu/index";
import { lesson as yourFirstKernel } from "./gpgpu-101/1-1-hello-kernel/3-your-first-kernel/index";
import { lesson as shapeYAndZ } from "./gpgpu-101/1-1-hello-kernel/4-shape-y-and-z/index";
import { lesson as mapOneThreadOneValue } from "./gpgpu-101/1-2-thinking-in-parallel/1-map-one-thread-one-value/index";
import { lesson as gatherReadAnywhere } from "./gpgpu-101/1-2-thinking-in-parallel/2-gather-read-anywhere/index";
import { lesson as noScatter } from "./gpgpu-101/1-2-thinking-in-parallel/3-no-scatter/index";
import { lesson as threadSync } from "./gpgpu-101/1-2-thinking-in-parallel/4-thread-sync/index";
import { lesson as reduction } from "./gpgpu-101/1-2-thinking-in-parallel/5-reduction/index";
import { lesson as bankConflict } from "./gpgpu-101/1-2-thinking-in-parallel/6-bank-conflict/index";

export const tracks: readonly Track[] = [
  {
    id: "gpgpu-101",
    number: 1,
    title: "GPGPU 101",
    tagline: "Threads, blocks, and the memory between them",
    modules: [
      {
        id: "1-1-hello-kernel",
        number: 1,
        title: "Hello World",
        blurb: "Compile and run a program, take a GPU round trip, then write a kernel that runs sixteen threads at once.",
        lessons: [helloWorld, helloFromTheGpu, yourFirstKernel, shapeYAndZ],
      },
      {
        id: "1-2-thinking-in-parallel",
        number: 2,
        title: "Thinking in Parallel",
        blurb: "Map, gather, sync, and bank conflicts.",
        lessons: [mapOneThreadOneValue, gatherReadAnywhere, noScatter, threadSync, reduction, bankConflict],
      },
    ],
  },
];

assertUniqueLessonIds(tracks);