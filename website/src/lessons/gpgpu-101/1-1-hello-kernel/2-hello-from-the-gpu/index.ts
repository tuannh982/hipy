import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";

export const lesson: Lesson = {
  id: "hello-from-the-gpu",
  number: 2,
  title: "Hello from the GPU",
  goal: "Allocate device memory, launch a kernel, and copy the result back — your first GPU round trip.",
  body,
  starter,
  assets: {},
};
