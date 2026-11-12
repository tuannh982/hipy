import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";
export const lesson: Lesson = { id: "thread-sync", number: 4, title: "Thread Sync", goal: "Use __shared__ and __syncthreads to cooperate within a block.", body, starter, assets: {} };