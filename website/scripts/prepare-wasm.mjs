// Builds the Go wasm harness the tests load directly: public/sim-runner.wasm and
// the matching public/wasm_exec.js. This is the driver-free subset of
// prepare-assets.mjs, which additionally needs the stripped LLVM driver and the
// resource archive. Runs standalone (`npm run prepare-wasm`, the `pretest`
// hook) and as a module for prepare-assets.mjs to reuse.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { brotliCompressSync, constants } from "node:zlib";
import { cp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const websiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const simHarnessRoot = resolve(websiteRoot, "..", "simulator");

export async function prepareWasmHarness() {
  const { stdout: goRoot } = await execFileAsync("go", ["env", "GOROOT"], { cwd: simHarnessRoot });
  await cp(join(goRoot.trim(), "lib", "wasm", "wasm_exec.js"), join(websiteRoot, "public", "wasm_exec.js"));
  const out = join(websiteRoot, "public", "sim-runner.wasm");
  await execFileAsync("go", ["build", "-o", out, "./cmd/sim-runner"], {
    cwd: simHarnessRoot,
    env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
  });
  const brotli = brotliCompressSync(await readFile(out), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  await writeFile(`${out}.br`, brotli);
  const rawMiB = (await readFile(out)).byteLength / (1024 * 1024);
  console.log(`sim-runner.wasm: ${rawMiB.toFixed(1)} MiB raw, ${(brotli.byteLength / (1024 * 1024)).toFixed(1)} MiB brotli`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await prepareWasmHarness();
}
