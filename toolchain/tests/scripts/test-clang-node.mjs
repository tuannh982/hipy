#!/usr/bin/env node
// Smoke test for the Node-based clang runner (toolchain/src/scripts/run-clang-node.mjs).
// Compiles and links a trivial C file to wasm32-wasi through the wasm llvm-driver.
//
// Prereqs:
//   npm ci --prefix toolchain/runner
//   toolchain/artifacts/llvm-driver.wasm   (from build-llvm.sh)
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Wasmer } = require(
  path.join(import.meta.dirname, "..", "..", "runner", "node_modules", "@wasmer", "sdk", "dist", "node.js")
);

const WASM = path.resolve(import.meta.dirname, "..", "..", "artifacts", "llvm-driver.wasm");
const TRIVIAL_C = "int add(int a, int b) { return a + b; }\n";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

const wasmer = new Wasmer();
try {
  const wasmBytes = await readFile(WASM);
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

  const vSandbox = await wasmer.sandboxes.create({ packages: [pkg] });
  const v = await vSandbox.command("clang", ["--version"]).run({ check: false });
  const vText = v.stdout.text();
  check(
    "clang --version",
    v.exitCode === 0 && vText.includes("clang version 19.1.6"),
    vText.split("\n")[0]
  );
  await vSandbox.close().catch(() => {});

  // clang spawns wasm-ld internally; the sandbox resolves it via commands.
  const sandbox = await wasmer.sandboxes.create({
    packages: [pkg],
    files: { "/workspace/trivial.c": TRIVIAL_C },
  });
  const out = await sandbox
    .command("clang", [
      "-c",
      "/workspace/trivial.c",
      "-o",
      "/workspace/trivial.o",
    ])
    .run({ check: false });
  check(
    "clang -c trivial.c (full driver, exit 0)",
    out.exitCode === 0,
    `exit=${out.exitCode} reason=${out.reason}`
  );
  if (out.exitCode === 0) {
    const obj = await sandbox.fs.readFile("/workspace/trivial.o");
    const magic = Array.from(obj.slice(0, 4));
    check("object file produced", magic.join(",") === "0,97,115,109", `${obj.length} bytes, magic=${magic}`);

    const link = await sandbox
      .command("wasm-ld", [
        "/workspace/trivial.o",
        "-o",
        "/workspace/trivial.wasm",
        "--no-entry",
        "--export=add",
      ])
      .run({ check: false });
    check(
      "link trivial.o (lld via clang)",
      link.exitCode === 0,
      `exit=${link.exitCode} ${link.stderr.text().slice(0, 100)}`
    );
    if (link.exitCode === 0) {
      const linked = await sandbox.fs.readFile("/workspace/trivial.wasm");
      check(
        "linked module valid magic",
        Array.from(linked.slice(0, 4)).join(",") === "0,97,115,109",
        `${linked.length} bytes`
      );
    }
  } else {
    console.error("stderr:", out.stderr.text().slice(0, 400));
  }
  await sandbox.close().catch(() => {});
} finally {
  await wasmer.close().catch(() => {});
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll clang node-runner tests passed");
process.exit(0);
