#!/usr/bin/env node
// Canonical local runner for the WASIX llvm-driver (toolchain/artifacts/llvm-driver.wasm).
//
// The browser runs the driver through @wasmer/sdk, so using the same engine
// here keeps local results aligned with the browser target.
//
// Usage: node toolchain/src/scripts/run-clang-node.mjs [--wasm PATH] <clang args...>
// Example:
//   node toolchain/src/scripts/run-clang-node.mjs -c hello.c -o hello.o
//
// Input files are staged into /workspace; outputs written there are copied back.
//
// @wasmer/sdk 0.16.0 is installed from the committed lockfile:
//   npm ci --prefix toolchain/runner
import { createRequire } from "node:module";
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Wasmer } = require(
  path.join(import.meta.dirname, "..", "..", "runner", "node_modules", "@wasmer", "sdk", "dist", "node.js")
);

const DEFAULT_WASM = path.join(import.meta.dirname, "..", "..", "artifacts", "llvm-driver.wasm");

let wasmPath = DEFAULT_WASM;
const argv = process.argv.slice(2);
const commandName = process.env.CLANG_COMMAND ?? "clang";
if (argv[0] === "--wasm") {
  wasmPath = path.resolve(argv[1]);
  argv.splice(0, 2);
}
if (argv.length === 0) {
  console.error("usage: run-clang-node.mjs [--wasm llvm-driver.wasm] <clang args...>");
  process.exit(2);
}

async function stageTree(hostRoot, guestRoot) {
  const entries = await readdir(hostRoot, { withFileTypes: true });
  for (const entry of entries) {
    const hostPath = path.join(hostRoot, entry.name);
    const guestPath = `${guestRoot}/${entry.name}`;
    if (entry.isDirectory()) {
      await sandbox.fs.mkdir(guestPath, { recursive: true });
      await stageTree(hostPath, guestPath);
    } else if (entry.isFile()) {
      await sandbox.fs.writeFile(guestPath, await readFile(hostPath));
    }
  }
}

const wasmer = new Wasmer();
let sandbox;
async function mapPath(arg, args, outputs) {
  try {
    const s = await stat(arg);
    const guest = "/workspace/" + path.basename(arg);
    if (s.isFile()) {
      await sandbox.fs.writeFile(guest, await readFile(arg));
    } else {
      await sandbox.fs.mkdir(guest, { recursive: true });
      await stageTree(arg, guest);
    }
    args.push(guest);
  } catch {
    const guest = "/workspace/" + path.basename(arg);
    outputs.set(guest, path.resolve(arg));
    args.push(guest);
  }
}
try {
  const wasmBytes = await readFile(wasmPath);
  // One module under every tool name: the driver dispatches on argv[0] (multicall).
  const pkg = await wasmer.packages.create({
    modules: { llvm: wasmBytes },
    commands: {
      clang: { module: "llvm" },
      "clang++": { module: "llvm" },
      "wasm-ld": { module: "llvm" },
      lld: { module: "llvm" },
      "llvm-objdump": { module: "llvm" },
    },
    entrypoint: "clang",
  });
  sandbox = await wasmer.sandboxes.create({ packages: [pkg] });

  // Rewrite host paths on the command line to /workspace; non-existent host paths
  // are guest outputs, copied back after the run.
  const args = [];
  const outputs = new Map(); // guest path -> host path
  const optionsWithValue = new Set([
    "-x",
    "-std",
    "-resource-dir",
    "-isysroot",
    "-isystem",
    "-I",
    "-include",
    "-internal-isystem",
    "-triple",
    "-target-cpu",
  ]);
  const pathOptions = new Set([
    "-resource-dir",
    "-isysroot",
    "-isystem",
    "-I",
    "-internal-isystem",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (optionsWithValue.has(arg)) {
      const value = argv[++i];
      args.push(arg);
      if (pathOptions.has(arg)) {
        await mapPath(value, args, outputs);
      } else {
        args.push(value);
      }
      continue;
    }
    if (arg.startsWith("-")) {
      args.push(arg);
      continue;
    }
    await mapPath(arg, args, outputs);
  }

  const out = await sandbox.command(commandName, args).run({ check: false });
  process.stdout.write(out.stdout.text());
  process.stderr.write(out.stderr.text());

  for (const [guest, hostOut] of outputs) {
    try {
      const data = await sandbox.fs.readFile(guest);
      await writeFile(hostOut, data);
    } catch {
      // output was not produced (error path) — leave host untouched
    }
  }
  process.exit(out.exitCode);
} catch (err) {
  console.error("run-clang-node:", err?.message ?? err);
  process.exit(1);
} finally {
  if (sandbox) await sandbox.close().catch(() => {});
  await wasmer.close().catch(() => {});
}
