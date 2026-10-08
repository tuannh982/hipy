import type { Track } from "./types";
import { assertUniqueLessonIds } from "./lookup";
import { lesson as helloWorld } from "./gpgpu-101/1-1-hello-kernel/hello-world/index";
import { lesson as yourFirstKernel } from "./gpgpu-101/1-1-hello-kernel/your-first-kernel/index";

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
        blurb: "Compile and run a program, then write a kernel that runs sixteen threads at once.",
        lessons: [helloWorld, yourFirstKernel],
      },
    ],
  },
];

assertUniqueLessonIds(tracks);
