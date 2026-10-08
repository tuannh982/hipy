import type { Lesson } from "../../../types";
import body from "./lesson.md?raw";
import starter from "./starter.cu?raw";

export const lesson: Lesson = {
  id: "hello-world",
  number: 1,
  title: "Hello from the CPU",
  goal: "Print `hello world` with `printf` and read it back out of the Console.",
  body,
  starter,
  assets: {},
};
