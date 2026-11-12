import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";
export const lesson: Lesson = { id: "no-scatter", number: 3, title: "No Scatter Allowed", goal: "Why kernels must not write to shared output cells.", body, starter, assets: {} };