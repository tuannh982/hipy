import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";

export const lesson: Lesson = {
  id: "shape-y-and-z",
  number: 4,
  title: "Shape: y and z",
  goal: "Launch threads in 2D and index them with threadIdx.x and threadIdx.y.",
  body,
  starter,
  assets: {},
};
