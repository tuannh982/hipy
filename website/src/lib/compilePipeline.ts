import { boundaryById, type ToolchainBoundary } from "./toolchainBoundaries";
import { allToolchains, archForDevice, offloadTarget, toolchainById, type Toolchain } from "./toolchains";

// The one rejection this module enforces, read from the table the toolchain's
// negative suite compiles against. Keyed by id rather than label: a label is free
// to be reworded, an id is not. A missing id throws at import rather than producing
// a learner-facing error with "undefined" in it.
function boundary(id: string): ToolchainBoundary {
  const row = boundaryById(id);
  if (row === null) throw new Error(`toolchain/boundaries.json has no boundary with id ${id}`);
  return row;
}

export type CompilerFileMap = Readonly<Record<string, Uint8Array>>;

export type CompilerCommandOutput = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export type CompilerFileSystem = {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
};

export type CompilerSandbox = {
  command(name: string, args: readonly string[]): {
    run(options?: { check?: boolean; timeoutMs?: number }): Promise<CompilerCommandOutput>;
  };
  fs: CompilerFileSystem;
};

export type CompilerRuntime = {
  createSandbox(driver: Uint8Array, files: CompilerFileMap): Promise<CompilerSandbox>;
  close(): Promise<void>;
};

export type CompilerAssets = {
  driver: Uint8Array;
  files: CompilerFileMap;
};

export type CompileEvent =
  | { type: "stage"; stage: "device" | "host" | "link" }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string };

// The device pass. The triple and the vendor-specific flags come from the toolchain
// row, never from literals here: a literal would compile a second vendor's device
// with the wrong target and only fail at the assembler. The arch is the only thing
// the caller supplies, and it is what -target-cpu carries -- the triple names the
// OS and ABI, not the ISA.
function deviceArgs(toolchain: Toolchain, arch: string): string[] {
  return [
    "-cc1",
    "-triple",
    toolchain.triple,
    "-target-cpu",
    arch,
    "-O2",
    "-emit-obj",
    "-x",
    "hip",
    "-std=c++17",
    "-nogpulib",
    "-nostdinc++",
    "-resource-dir",
    "/workspace/resource",
    "-isysroot",
    "/workspace/sysroot",
    "-isystem",
    "/workspace/sysroot/include",
    "-internal-isystem",
    "/workspace/sysroot/include/c++/v1",
    "-I",
    "/workspace/shim/include",
    "-include",
    "cuda_runtime.h",
    ...toolchain.devicePassArgs,
    "/workspace/source.cu",
    "-o",
    "/workspace/device.o",
  ];
}

// The flags the host pass needs regardless of toolchain: a wasm32-wasi module
// either way, linking against the same runtime bridge.
const hostCommonArgs = [
  "-x",
  "hip",
  "-std=c++17",
  "-nogpulib",
  "-nostdinc++",
  "-resource-dir",
  "/workspace/resource",
  "-isysroot",
  "/workspace/sysroot",
  "-isystem",
  "/workspace/sysroot/include",
  "-I",
  "/workspace/shim/include",
  "-include",
  "cuda_runtime.h",
];

const decoder = new TextDecoder();

function isElf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function compilePipeline({
  source,
  assets,
  runtime,
  toolchainId,
  arch,
  device,
  onEvent = () => {},
}: {
  source: string;
  assets: CompilerAssets;
  runtime: CompilerRuntime;
  /**
   * The toolchain that compiles the device side. Required, with no fallback: a
   * build that guessed would compile for a part no one selected, and the mismatch
   * is silent.
   */
  toolchainId: string;
  /**
   * The ISA to emit. The caller takes this from the same catalog entry as
   * toolchainId, so the device decides both together; `device` is carried
   * alongside so the arch can be re-derived rather than trusted.
   */
  arch: string;
  /** Used only to cross-check `arch` against the registry. */
  device?: string;
  onEvent?: (event: CompileEvent) => void;
}): Promise<{ deviceCodeObject: ArrayBuffer; hostWasm: ArrayBuffer }> {
  // Resolve the toolchain before anything is created, so a name the registry does
  // not have is a message rather than a clang diagnostic about unknown flags.
  const toolchain = toolchainById(toolchainId);
  if (toolchain === null) {
    throw new Error(
      `no toolchain named "${toolchainId}" in toolchain/toolchains.json; ` +
      `this build ships ${allToolchains().map((row) => row.id).join(", ")}`,
    );
  }
  // The arch is a claim about a device, so check it against the registry: an arch
  // no device maps to is either a typo or a stale bundle, and clang would accept
  // either and emit a code object nothing asked for.
  const expected = device === undefined ? null : archForDevice(toolchainId, device);
  if (expected !== null && expected !== arch) {
    throw new Error(`device "${device}" on toolchain "${toolchainId}" is ${expected}, not the requested ${arch}`);
  }
  if (typeof arch !== "string" || arch.trim() === "") {
    throw new Error(`no target arch for device "${String(device)}" on toolchain "${toolchainId}"`);
  }

  const files = { ...assets.files, "/workspace/source.cu": new TextEncoder().encode(source) };
  let sandbox: CompilerSandbox | undefined;
  try {
    sandbox = await runtime.createSandbox(assets.driver, files);
    if (!sandbox) throw new Error("compiler sandbox was not created");
    onEvent({ type: "stage", stage: "device" });
    await run(sandbox, "clang++", deviceArgs(toolchain, arch), onEvent);
    let deviceCodeObject = await sandbox.fs.readFile("/workspace/device.o");
    if (!isElf(deviceCodeObject)) {
      await run(sandbox, "clang-offload-bundler", [
        "--type=o",
        "--unbundle",
        "--inputs=/workspace/device.o",
        `--targets=${offloadTarget(toolchain, arch)}`,
        "--outputs=/workspace/device.co",
      ], onEvent);
      deviceCodeObject = await sandbox.fs.readFile("/workspace/device.co");
    }
    if (deviceCodeObject.byteLength === 0) throw new Error("device.co was not produced");

    onEvent({ type: "stage", stage: "host" });
    await run(sandbox, "clang++", [
      ...hostCommonArgs,
      "--target=wasm32-wasi",
      "--offload-host-only",
      "-pthread",
      "-c",
      "/workspace/source.cu",
      "-o",
      "/workspace/host.o",
    ], onEvent);
    const tokenOutput = await run(sandbox, "clang++", [
      ...hostCommonArgs,
      "--target=wasm32-wasi",
      "--offload-host-only",
      "-pthread",
      "-Xclang",
      "-dump-raw-tokens",
      "-fsyntax-only",
      "/workspace/source.cu",
    ], onEvent, false);
    checkFp32(tokenOutput);

    onEvent({ type: "stage", stage: "link" });
    await run(sandbox, "wasm-ld", [
      "/workspace/host.o",
      "-o",
      "/workspace/host.wasm",
      "--allow-undefined",
      "--no-entry",
      "--export=main",
    ], onEvent);
    const hostWasm = await sandbox.fs.readFile("/workspace/host.wasm");
    if (hostWasm.byteLength === 0) throw new Error("host.wasm was not produced");
    return { deviceCodeObject: arrayBuffer(deviceCodeObject), hostWasm: arrayBuffer(hostWasm) };
  } finally {
    await runtime.close();
  }
}

async function run(
  sandbox: CompilerSandbox,
  command: string,
  args: readonly string[],
  onEvent: (event: CompileEvent) => void,
  emitOutput = true,
): Promise<CompilerCommandOutput> {
  const output = await sandbox.command(command, args).run({ check: false, timeoutMs: 120000 });
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);
  if (emitOutput && stdout) onEvent({ type: "stdout", text: stdout });
  if (emitOutput && stderr) onEvent({ type: "stderr", text: stderr });
  if (output.exitCode !== 0) {
    throw new Error(`${command} exited with status ${output.exitCode}${stderr ? `: ${stderr.trim()}` : ""}`);
  }
  return output;
}

function checkFp32(output: CompilerCommandOutput): void {
  const text = `${decoder.decode(output.stdout)}\n${decoder.decode(output.stderr)}`;
  const lines = text.split(/\r?\n/).filter((line) => line.includes("Loc=</workspace/source.cu:"));
  const offending = lines.find((line) => line.includes("raw_identifier 'double'")) ?? lines.find((line) => {
    const match = line.match(/numeric_constant '([^']+)'/);
    if (!match) return false;
    const value = match[1];
    return /^(?:\d|0[xX])/i.test(value) && /[.ep]/i.test(value) && !/[fF]$/.test(value);
  });
  if (!offending) return;
  const line = offending.match(/:(\d+):\d+>$/)?.[1] ?? "unknown";
  // The message is read from toolchain/boundaries.json rather than written here,
  // so it is the same sentence the toolchain's own check-fp32.mjs emits. The row
  // holds the stable prefix and this site appends its own source location.
  throw new Error(`${boundary("fp64").message} (source.cu:${line})`);
}
