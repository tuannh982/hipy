import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";

export const lesson: Lesson = {
  id: "your-first-kernel",
  number: 3,
  title: "Your First Kernel",
  goal: "Launch 16 threads and have each write the number 42 into its own cell — your first parallel program.",
  body,
  starter,
  assets: {},
};
