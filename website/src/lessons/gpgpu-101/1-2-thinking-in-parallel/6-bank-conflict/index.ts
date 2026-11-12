import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";
export const lesson: Lesson = { id: "bank-conflict", number: 6, title: "Bank Conflict", goal: "Understand shared-memory bank conflicts and avoid them with padding.", body, starter, assets: {} };