// Single source of truth for the deployed location and encoding of the staged
// toolchain assets. There is now one driver and one archive PER TOOLCHAIN, so
// every URL is keyed by the toolchain id rather than written out once; the
// manifest sits at the top because it is the index that lists them.
//
// Three consumers must agree, and two of them run in different processes:
//
//   website/vite.config.ts     reads it to set Vite's `base` (and therefore the
//                              `/assets/...` URLs in the built index.html) and to
//                              compile the per-toolchain driver and archive URLs
//                              into src/lib/assetCache.ts
//   website/scripts/prepare-assets.mjs
//                              reads it to lay out public/toolchain/<id>/ and to
//                              write the driver and archive `url` fields of
//                              public/toolchain/manifest.json
//   website/src/lib/assetCache.ts
//                              reads the compiled-in `__HIPY_TOOLCHAIN_*__`
//                              constants that vite.config.ts derives from here
//
// That last one is the reason this module exists rather than a path string in
// each place: loadToolchainAssets asserts every manifest URL is exactly the
// runtime constant for its toolchain id, so the manifest and the runtime
// constants have to be computed from the same function, not written out twice.
//
// Environment variables (both optional, both default to today's behavior):
//
//   VITE_BASE_PATH         Deployment subpath, e.g. "/hipy" for a GitHub Pages
//                          project site. Must be an absolute path. Default "/",
//                          which serves from a domain root.
//   VITE_DRIVER_ENCODING   "brotli" (default) emits `llvm-driver-v1.wasm.br`
//                          and relies on the host returning
//                          `Content-Encoding: br`, which is what
//                          public/_headers configures. "raw" emits the
//                          uncompressed `llvm-driver-v1.wasm` instead, for
//                          hosts that cannot set that header, at the cost of
//                          shipping ~72 MB instead of ~14 MB.
//
// The encoding is global even though the drivers are per toolchain: it is a
// property of what the host can serve, and a site that has to ship raw ships
// every driver raw.
import type { Toolchain } from "./src/lib/toolchains.ts";

const TOOLCHAIN_DIR = "toolchain";
const ARCHIVE_FILE_NAME = "toolchain.tar.gzip";
const DEFAULT_BASE_PATH = "/";
const DRIVER_ENCODINGS = {
  brotli: ".br",
  raw: "",
} as const;

export type DriverEncoding = keyof typeof DRIVER_ENCODINGS;

export type ToolchainPaths = {
  /** Vite `base`: absolute, exactly one trailing slash. */
  base: string;
  driverEncoding: DriverEncoding;
  /** One URL per toolchain id; must equal what manifest.json lists for that id. */
  driverUrls: Readonly<Record<string, string>>;
  /** One URL per toolchain id; must equal what manifest.json lists for that id. */
  archiveUrls: Readonly<Record<string, string>>;
  manifestUrl: string;
};

/** The deployed driver file name for one toolchain under one encoding. */
export function driverFileName(toolchain: Toolchain, encoding: DriverEncoding = "brotli"): string {
  return `${toolchain.driverFile}${DRIVER_ENCODINGS[encoding]}`;
}

/**
 * Resolve the toolchain asset paths for one build.
 *
 * @param toolchains Every toolchain the build stages, in registry order.
 * @param env Environment to read, `process.env` by default.
 */
export function resolveToolchainPaths(
  toolchains: readonly Toolchain[],
  env: Record<string, string | undefined> = process.env,
): ToolchainPaths {
  const base = resolveBasePath(env.VITE_BASE_PATH);
  const driverEncoding = resolveDriverEncoding(env.VITE_DRIVER_ENCODING);
  const driverUrls: Record<string, string> = {};
  const archiveUrls: Record<string, string> = {};
  for (const toolchain of toolchains) {
    driverUrls[toolchain.id] = toolchainUrl(base, toolchain.id, driverFileName(toolchain, driverEncoding));
    archiveUrls[toolchain.id] = toolchainUrl(base, toolchain.id, ARCHIVE_FILE_NAME);
  }
  return {
    base,
    driverEncoding,
    driverUrls,
    archiveUrls,
    manifestUrl: toolchainUrl(base, undefined, "manifest.json"),
  };
}

/** Normalize a deployment subpath to a Vite `base`: absolute, one trailing slash. */
function resolveBasePath(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") return DEFAULT_BASE_PATH;
  if (!raw.startsWith("/")) {
    throw new Error(`VITE_BASE_PATH must be an absolute path such as "/hipy", got "${raw}"`);
  }
  if (raw.includes("://") || raw.includes("..") || raw.includes("?")) {
    throw new Error(`VITE_BASE_PATH must be a plain path, not a URL or a relative path, got "${raw}"`);
  }
  return `${raw.replace(/\/+$/, "")}/`;
}

function resolveDriverEncoding(value: string | undefined): DriverEncoding {
  const raw = (value ?? "").trim();
  if (raw === "") return "brotli";
  if (!Object.hasOwn(DRIVER_ENCODINGS, raw)) {
    throw new Error(`VITE_DRIVER_ENCODING must be one of ${Object.keys(DRIVER_ENCODINGS).join(", ")}, got "${raw}"`);
  }
  return raw as DriverEncoding;
}

function toolchainUrl(base: string, toolchainId: string | undefined, fileName: string): string {
  // The manifest is the index, so it sits beside the per-toolchain directories
  // rather than inside one; it has to be readable before an id is known.
  return toolchainId === undefined
    ? `${base}${TOOLCHAIN_DIR}/${fileName}`
    : `${base}${TOOLCHAIN_DIR}/${toolchainId}/${fileName}`;
}