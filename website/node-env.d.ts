// Build-time configuration runs in Node, but this project deliberately does not
// depend on @types/node (the browser bundle is type-checked with the same
// tsconfig, and only `types: ["vite/client"]` is installed). Declare the single
// global the build config needs rather than adding a dependency for it.
declare const process: {
  env: Record<string, string | undefined>;
};

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readFileSync(path: string): Uint8Array;
}
declare module "node:fs/promises" {
  export function rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>;
}
declare module "node:path" {
  export function join(...segments: string[]): string;
  export function dirname(path: string): string;
  export const posix: {
    normalize(path: string): string;
    join(...segments: string[]): string;
    dirname(path: string): string;
    relative(from: string, to: string): string;
    basename(path: string): string;
  };
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
