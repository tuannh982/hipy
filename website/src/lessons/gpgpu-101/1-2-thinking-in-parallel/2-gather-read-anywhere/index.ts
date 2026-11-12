import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";
export const lesson: Lesson = { id: "gather-read-anywhere", number: 2, title: "Gather: Read Anywhere", goal: "Each thread reads multiple inputs — the gather pattern.", body, starter, assets: {} };