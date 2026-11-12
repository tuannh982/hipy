import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";

export const lesson: Lesson = {
  id: "map-one-thread-one-value",
  number: 1,
  title: "Map: One Thread, One Value",
  goal: "One thread computes one output element — the map pattern.",
  body,
  starter,
  assets: {},
};
