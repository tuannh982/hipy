import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";
export const lesson: Lesson = { id: "bank-conflict", number: 6, title: "Bank Conflict", goal: "Understand shared-memory bank conflicts and avoid them with padding.", body, starter, assets: { "bank-conflict.mp4": "/remotion/bank-conflict/bank-conflict.mp4", "bank-no-conflict.mp4": "/remotion/bank-conflict/bank-no-conflict.mp4", "bank-same-address.mp4": "/remotion/bank-conflict/bank-same-address.mp4" } };