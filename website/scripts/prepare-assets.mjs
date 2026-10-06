import { execFile } from "node:child_process";
import { brotliCompressSync, constants } from "node:zlib";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWasmHarness } from "./prepare-wasm.mjs";
import { allToolchains } from "../src/lib/toolchains.ts";
import { driverFileName, resolveToolchainPaths } from "../toolchain-paths.ts";

const execFileAsync = promisify(execFile);
const websiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolchainRoot = resolve(websiteRoot, "..", "toolchain");
const publicRoot = join(websiteRoot, "public", "toolchain");
await prepareWasmHarness();

// The emitted layout and the manifest URLs both come from toolchain-paths.ts, and
// the set of toolchains comes from toolchain/toolchains.json -- the same module
// vite.config.ts reads to set `base` and to compile the per-toolchain driver and
// archive URLs into assetCache.ts. That is what keeps every URL in manifest.json
// equal to the constant loadToolchainAssets asserts against; none of them is
// written out here.
//
// One directory per toolchain, holding that toolchain's driver and its sandbox
// archive, so a device naming a second toolchain fetches a second driver and
// nothing else changes.
const toolchains = allToolchains();
const paths = resolveToolchainPaths(toolchains);

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });

const archiveStaging = new Map();
try {
  const staged = [];
  for (const toolchain of toolchains) {
    // Two roots with the same short name: `stagedRoot` is the directory this
    // toolchain's assets go to, and `toolchainRoot` is the toolchain module it
    // reads them from. Conflating them sends the driver lookup into public/.
    const stagedRoot = join(publicRoot, toolchain.id);
    await mkdir(stagedRoot, { recursive: true });

    const driverSource = join(toolchainRoot, "artifacts", toolchain.driverArtifact);
    const driverBytes = await readFile(driverSource);
    await writeFile(join(stagedRoot, driverFileName(toolchain, paths.driverEncoding)), driverBytes);
    let driverWireBytes = driverBytes.byteLength;
    if (paths.driverEncoding === "brotli") {
      // Served with `Content-Encoding: br` by the hosts that read public/_headers,
      // so the browser decompresses it transparently. A host that cannot set that
      // header (GitHub Pages) serves the Brotli bytes verbatim and the driver then
      // fails to instantiate, which is what VITE_DRIVER_ENCODING=raw avoids.
      const brotli = brotliCompressSync(driverBytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      });
      await writeFile(join(stagedRoot, `${toolchain.driverFile}.br`), brotli);
      driverWireBytes = brotli.byteLength;
    }

    // What the sandbox mounts at /workspace: the shim, the resource dir, and the
    // sysroot. A toolchain whose headers differ stages its own directories,
    // which is why the list is a registry field rather than three constants here.
    const staging = await mkdtemp(join(tmpdir(), "hipy-toolchain-"));
    archiveStaging.set(toolchain.id, staging);
    for (const dir of toolchain.archiveDirs ?? []) {
      await cp(join(toolchainRoot, dir.from), join(staging, dir.to), { recursive: true });
    }
    const archivePath = join(stagedRoot, "toolchain.tar.gzip");
    await execFileAsync("tar", ["--format", "ustar", "-czf", archivePath, "-C", staging, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    const archiveBytes = (await stat(archivePath)).size;
    const archiveFiles = await filesUnder(staging);
    const archiveUncompressed = archiveFiles.reduce((sum, file) => sum + file.size, 0);
    staged.push({
      id: toolchain.id,
      label: toolchain.label,
      driver: paths.driverUrls[toolchain.id],
      driverSize: driverBytes.byteLength,
      driverWireBytes,
      archives: [{
        url: paths.archiveUrls[toolchain.id],
        size: archiveBytes,
        mount: "/workspace",
        fileCount: archiveFiles.length,
        uncompressedSize: archiveUncompressed,
      }],
      archiveFiles,
      archiveUncompressed,
    });
  }

  // The manifest carries only what the browser asserts on: the URL and the byte
  // count of each asset, so a wrong size or a stale URL is a load-time error
  // rather than a truncated driver. The staging-only fields are dropped here.
  await writeFile(join(publicRoot, "manifest.json"), JSON.stringify({
    version: 3,
    toolchains: staged.map((entry) => ({
      id: entry.id,
      driver: entry.driver,
      driverSize: entry.driverSize,
      archives: entry.archives,
    })),
  }, null, 2));

  const encodingNote = paths.driverEncoding === "brotli"
    ? (wireBytes) => `brotli q11, ${wireBytes} bytes on the wire, requires the host to send Content-Encoding: br`
    : (wireBytes) => `uncompressed, ${wireBytes} bytes on the wire, no Content-Encoding required ` +
      `(the brotli build this replaces transfers a fraction of that; see toolchain-paths.ts)`;
  for (const entry of staged) {
    console.log(`toolchain ${entry.id}: ${entry.driverSize} bytes driver, ${encodingNote(entry.driverWireBytes)}`);
    console.log(`archive: ${entry.archives[0].url} -> ${entry.archives[0].size} bytes, ${entry.archiveFiles.length} files, ${entry.archiveUncompressed} bytes uncompressed`);
    for (const dir of toolchains.find((row) => row.id === entry.id)?.archiveDirs ?? []) {
      const size = entry.archiveFiles.filter((file) => file.path.startsWith(dir.to)).reduce((sum, file) => sum + file.size, 0);
      console.log(`${dir.to}: ${size} bytes`);
    }
  }
  console.log(`assets: ${staged.length} toolchains, ${staged.length} archives, ${staged.length} drivers`);
  console.log(`base:   ${paths.base} (manifest: ${paths.manifestUrl})`);
} finally {
  for (const staging of archiveStaging.values()) {
    await rm(staging, { recursive: true, force: true });
  }
}

async function filesUnder(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path: relative(root, path).split(/[\\/]/).join("/"), size: (await stat(path)).size });
    }
  }
  await visit(root);
  return files;
}