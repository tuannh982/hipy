import { defineConfig } from "vite";
import { allToolchains } from "./src/lib/toolchains.ts";
import { resolveToolchainPaths } from "./toolchain-paths.ts";

const contentSecurityPolicy = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; child-src 'self' blob:; connect-src 'self' blob: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const isolationHeaders = {
  "Content-Security-Policy": contentSecurityPolicy,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Resolve VITE_BASE_PATH and VITE_DRIVER_ENCODING once, here, and compile the
// toolchain URLs into the bundle -- one driver and one archive per toolchain,
// keyed by the id a device's catalog entry names. scripts/prepare-assets.mjs
// resolves the same variables through the same module to write manifest.json,
// which is what keeps every URL in it equal to the constant assetCache.ts asserts
// against. See toolchain-paths.ts.
//
// What is NOT compiled in is an ISA. It is a fact about the device the learner
// selected, carried on the request from the simulator's own catalog, and the toolchain
// that produces it is a runtime choice among the rows in toolchain/toolchains.json.
// See src/lib/toolchains.ts.
const toolchains = allToolchains();
const toolchain = resolveToolchainPaths(toolchains);

export default defineConfig({
  base: toolchain.base,
  define: {
    __HIPY_TOOLCHAIN_DRIVER_URLS__: JSON.stringify(toolchain.driverUrls),
    __HIPY_TOOLCHAIN_ARCHIVE_URLS__: JSON.stringify(toolchain.archiveUrls),
    __HIPY_TOOLCHAIN_MANIFEST_URL__: JSON.stringify(toolchain.manifestUrl),
  },
  build: { assetsInlineLimit: 0 },
  // src/App.tsx imports simulator/testdata/fixtures.json for the example
  // titles, so that the picker, the harness and the example test all read one
  // name for an example. That file lives outside this package, so the dev server
  // needs its directory on the serving allow list; build-time resolution follows
  // the import with no help. "." is this package's own root, which Vite allows by
  // default -- setting fs.allow replaces that default rather than extending it,
  // so the site's own sources are listed back in alongside the manifest. The
  // manifest's directory is named, not the whole repo, and the path is relative
  // because this config avoids node: imports (see node-env.d.ts).
  //
  // ../toolchain is on the list for the same reason: ToolchainBoundaries.tsx imports
  // toolchain/boundaries.json, the table toolchain/tests/scripts/
  // compile-failure-test.mjs asserts. A directory rather than the one file because
  // fs.allow takes directories.
  server: { headers: isolationHeaders, fs: { allow: [".", "../simulator/testdata", "../toolchain"] } },
  preview: { headers: isolationHeaders },
});
