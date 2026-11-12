import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";
export const lesson: Lesson = { id: "reduction", number: 5, title: "Reduction", goal: "Sum an array in parallel using a tree reduction.", body, starter, assets: {} };