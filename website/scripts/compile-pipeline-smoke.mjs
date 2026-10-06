import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Wasmer } from "@wasmer/sdk/node";
import { compilePipeline } from "../src/lib/compilePipeline.ts";
import { allToolchains, toolchainById } from "../src/lib/toolchains.ts";

// Driven by the registry, like every other caller: the toolchain names the driver
// artifact to read and the device-pass flags to add, so this script exercises the
// same row the browser would. TOOLCHAIN and DEVICE default to the registry's first
// row and its first device; both can be overridden from the environment to
// compile for something else without editing the script.
const root = resolve(process.cwd(), "..");
const TOOLCHAIN_ID = process.env.TOOLCHAIN ?? allToolchains()[0].id;
const DEVICE = process.env.DEVICE ?? Object.keys(allToolchains()[0].devices)[0];
const toolchain = toolchainById(TOOLCHAIN_ID);
if (toolchain === null) throw new Error(`toolchain/toolchains.json has no toolchain "${TOOLCHAIN_ID}"`);
const arch = process.env.ARCH ?? toolchain.devices[DEVICE];
if (arch === undefined) throw new Error(`toolchain "${TOOLCHAIN_ID}" claims no device "${DEVICE}"`);
const driver = await readFile(join(root, "toolchain/artifacts", toolchain.driverArtifact));
const files = {};

async function addTree(hostRoot, guestRoot) {
  const entries = await readdir(hostRoot, { withFileTypes: true });
  for (const entry of entries) {
    const hostPath = join(hostRoot, entry.name);
    const guestPath = `${guestRoot}/${entry.name}`;
    if (entry.isDirectory()) await addTree(hostPath, guestPath);
    else if (entry.isFile()) files[guestPath] = new Uint8Array(await readFile(hostPath));
  }
}

// The sandbox archive's contents are the registry's archiveDirs, so a toolchain
// whose headers differ stages its own directories here too.
for (const dir of toolchain.archiveDirs ?? []) {
  await addTree(join(root, "toolchain", dir.from), `/workspace/${dir.to}`);
}

let wasmer;
let sandbox;
const runtime = {
  async createSandbox(driverBytes, guestFiles) {
    wasmer = new Wasmer({ cache: false });
    await wasmer.ready();
    const pkg = await wasmer.packages.create({
      modules: { llvm: driverBytes },
      commands: {
        clang: { module: "llvm" },
        "clang++": { module: "llvm" },
        "clang-offload-bundler": { module: "llvm" },
        "wasm-ld": { module: "llvm" },
      },
      entrypoint: "clang++",
    });
    sandbox = await wasmer.sandboxes.create({ packages: [pkg] });
    await sandbox.fs.mkdir("/workspace", { recursive: true });
    for (const [path, contents] of Object.entries(guestFiles)) {
      const slash = path.lastIndexOf("/");
      if (slash > 0) await sandbox.fs.mkdir(path.slice(0, slash), { recursive: true });
      await sandbox.fs.writeFile(path, contents);
    }
    return {
      command(name, args) {
        const command = sandbox.command(name, args);
        return {
          async run(options) {
            const output = await command.run(options);
            return { exitCode: output.exitCode, stdout: output.stdout.bytes, stderr: output.stderr.bytes };
          },
        };
      },
      fs: sandbox.fs,
    };
  },
  async close() {
    await sandbox?.close().catch(() => {});
    await wasmer?.close().catch(() => {});
  },
};

const sourcePath = process.env.SRC ?? join(root, "toolchain/tests/cuda/vectoradd.cu");
const source = await readFile(sourcePath, "utf8");
const result = await compilePipeline({
  source,
  assets: { driver: new Uint8Array(driver), files },
  runtime,
  toolchainId: toolchain.id,
  arch,
  device: DEVICE,
  onEvent: (event) => {
    if (event.type === "stage") console.log(`stage: ${event.stage}`);
    else if (event.type === "stdout" || event.type === "stderr") process[event.type].write(event.text);
  },
});
if (result.deviceCodeObject.byteLength === 0 || result.hostWasm.byteLength === 0) {
  throw new Error("compile pipeline returned empty artifacts");
}
console.log(`compile pipeline ok: ${toolchain.id}/${arch} device.co=${result.deviceCodeObject.byteLength} host.wasm=${result.hostWasm.byteLength}`);
