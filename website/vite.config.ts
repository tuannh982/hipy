import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
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

const SDK_RUNTIME_ROOTS = ["dist/browser-worker.js", "pkg/wasmer_sdk_js.js"];
const OVERSIZED_HARNESS = "sim-runner.wasm";

function deployableAssets(): Plugin {
  const packageRoot = path.dirname(fileURLToPath(import.meta.url));
  const sdkRoot = path.join(packageRoot, "node_modules", "@wasmer", "sdk");
  const distDir = path.join(packageRoot, "dist");
  const relativeImport = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s+\*\s+from\s*)["'](\.{1,2}\/[^"'\n]+)["']/g;

  return {
    name: "hipy:deployable-assets",
    apply: "build",
    generateBundle() {
      for (const root of SDK_RUNTIME_ROOTS) {
        const emitBase = path.posix.dirname(root);
        const seen = new Set<string>();
        const stack = [root];
        while (stack.length > 0) {
          const current = stack.pop() as string;
          if (seen.has(current)) continue;
          seen.add(current);
          const absolute = path.join(sdkRoot, current);
          if (!existsSync(absolute)) continue;
          for (const match of readFileSync(absolute, "utf8").matchAll(relativeImport)) {
            stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(current), match[1])));
          }
          const emitted = path.posix.relative(emitBase, current);
          if (emitted === path.posix.basename(root) || emitted.endsWith(".d.ts")) continue;
          this.emitFile({
            type: "asset",
            fileName: `assets/${emitted}`,
            source: readFileSync(absolute),
          });
        }
      }
    },

    async closeBundle() {
      await rm(path.join(distDir, OVERSIZED_HARNESS), { force: true });
    },
  };
}

export default defineConfig({
  base: toolchain.base,
  plugins: [deployableAssets()],
  define: {
    __HIPY_TOOLCHAIN_DRIVER_URLS__: JSON.stringify(toolchain.driverUrls),
    __HIPY_TOOLCHAIN_ARCHIVE_URLS__: JSON.stringify(toolchain.archiveUrls),
    __HIPY_TOOLCHAIN_MANIFEST_URL__: JSON.stringify(toolchain.manifestUrl),
  },
  build: { assetsInlineLimit: 0 },
  // src/examples/registry.ts imports simulator/testdata/fixtures.json for the example
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
