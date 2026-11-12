#!/usr/bin/env node
// Checks that a WASIX llvm-driver can actually be spawned by wasmer.
//
//   node verify-driver.mjs <driver.wasm>
//
// The stripped driver is what the browser downloads and spawns, so a driver
// wasmer cannot validate is worse than no driver at all: the build succeeds
// and the failure shows up in the playground as "Compile error: ... unable to
// spawn the command: compile error: Validate(...)". Verifying the artifact
// where it is produced turns that into a build failure.
//
// The check is a spawn, not a parse: the import section has to be in an
// encoding wasmer accepts, and only spawning proves that.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SDK = path.join(
  import.meta.dirname, "..", "..", "runner", "node_modules", "@wasmer", "sdk", "dist", "node.js",
);

const driverPath = process.argv[2];
if (!driverPath) {
  console.error("usage: verify-driver.mjs <driver.wasm>");
  process.exit(2);
}

let Wasmer;
try {
  ({ Wasmer } = require(SDK));
} catch (err) {
  console.error(
    `verify-driver.mjs: cannot load @wasmer/sdk from ${SDK} (${err?.message ?? err}).\n` +
    "Run 'npm ci --prefix toolchain/runner' first.",
  );
  process.exit(1);
}

const wasmer = new Wasmer();
let sandbox;
try {
  const driver = await readFile(driverPath);
  const pkg = await wasmer.packages.create({
    modules: { llvm: driver },
    commands: {
      clang: { module: "llvm" },
      "clang++": { module: "llvm" },
      "clang-offload-bundler": { module: "llvm" },
      "wasm-ld": { module: "llvm" },
    },
    entrypoint: "clang",
  });
  sandbox = await wasmer.sandboxes.create({ packages: [pkg] });
  const out = await sandbox.command("clang", ["--version"]).run({ check: false });
  if (out.exitCode !== 0) {
    console.error(
      `verify-driver.mjs: ${driverPath} ran but exited ${out.exitCode}: ${out.stderr.text().slice(0, 400)}`,
    );
    process.exit(1);
  }
  console.log(`verify-driver.mjs: ${path.basename(driverPath)} spawns: ${out.stdout.text().split("\n")[0]}`);
} catch (err) {
  console.error(`verify-driver.mjs: ${driverPath} cannot be spawned by wasmer: ${err?.message ?? err}`);
  process.exit(1);
} finally {
  await sandbox?.close().catch(() => {});
  await wasmer.close().catch(() => {});
}
