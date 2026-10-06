// Build-time configuration runs in Node, but this project deliberately does not
// depend on @types/node (the browser bundle is type-checked with the same
// tsconfig, and only `types: ["vite/client"]` is installed). Declare the single
// global the build config needs rather than adding a dependency for it.
declare const process: {
  env: Record<string, string | undefined>;
};
