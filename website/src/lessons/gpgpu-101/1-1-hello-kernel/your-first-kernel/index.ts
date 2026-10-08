import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";
import threadFanout from "./thread-fanout.svg?url";

export const lesson: Lesson = {
  id: "your-first-kernel",
  number: 2,
  title: "Your First Kernel",
  goal: "Launch 16 threads and have each write the number 42 into its own cell — your first parallel program.",
  body,
  starter,
        assets: { "thread-fanout.svg": threadFanout },
};
