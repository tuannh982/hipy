#!/usr/bin/env node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
// The shared boundary table, read for the one message this suite asserts below.
const boundaries = JSON.parse(await readFile(path.join(root, "boundaries.json"), "utf8")).boundaries;
const require = createRequire(import.meta.url);
const { Wasmer } = require(path.join(root, "runner", "node_modules", "@wasmer", "sdk", "dist", "node.js"));
const driver = path.join(root, "artifacts", "llvm-driver-stripped.wasm");
const shim = path.join(root, "src", "shim", "include");
const resource = path.join(root, "artifacts", "build-wasm", "lib", "clang", "19");
const sysroot = path.join(root, "artifacts", "wasix-sysroot");
const hostRuntimeSymbols = [
    "__hipPopCallConfiguration",
    "hipLaunchKernel",
    "cudaMemcpy",
    "cudaMemset",
    "__hipPushCallConfiguration",
    "cudaGetLastError",
    "cudaDeviceSynchronize",
    "cudaFree",
    "cudaMalloc",
    "__hipRegisterFunction",
    "__hipRegisterFatBinary",
    "atexit",
    "__hipUnregisterFatBinary",
    "printf",
];
const wasmSignatures = {
    __hipPopCallConfiguration: "(param i32 i32 i32 i32) (result i32)",
    hipLaunchKernel: "(param i32 i32 i32 i32 i32 i32) (result i32)",
    cudaMemcpy: "(param i32 i32 i32 i32) (result i32)",
    cudaMemset: "(param i32 i32 i32) (result i32)",
    __hipPushCallConfiguration: "(param i32 i32 i32 i32) (result i32)",
    cudaGetLastError: "(result i32)",
    cudaDeviceSynchronize: "(result i32)",
    cudaFree: "(param i32) (result i32)",
    cudaMalloc: "(param i32 i32) (result i32)",
    __hipRegisterFunction: "(param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)",
    __hipRegisterFatBinary: "(param i32) (result i32)",
    atexit: "(param i32) (result i32)",
    __hipUnregisterFatBinary: "(param i32)",
    printf: "(param i32 i32) (result i32)",
};
const mainSignature = "(param i32 i32) (result i32)";

const srcName = process.env.SRC_NAME ?? "vectoradd.cu";
const srcStem = srcName.replace(/\.cu$/, "");
const manifestUrl = new URL("../../../simulator/testdata/fixtures.json", import.meta.url);

function matchingLine(text, pattern) {
    return text.split(/\r?\n/).find((line) => pattern.test(line)) ?? "";
}

function wasmFunctionIndex(text, kind, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (kind === "import") {
        return text.match(new RegExp(`^\\s*\\(import "env" "${escapedName}" \\(func .*?\\(type (\\d+)\\)\\)\\)$`, "m"))?.[1] ?? "";
    }
    const functionName = text.match(new RegExp(`^\\s*\\(export "${escapedName}" \\(func ([^)]+)\\)\\)$`, "m"))?.[1] ?? "";
    const escapedFunction = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return functionName === "" ? "" : text.match(new RegExp(`^\\s*\\(func ${escapedFunction} \\([^\\n]*?\\(type (\\d+)\\)`, "m"))?.[1] ?? "";
}

function wasmTypeSignature(text, index) {
    return text.match(new RegExp(`^\\s*\\(type \\(;${index};\\) \\(func (.*)\\)\\)$`, "m"))?.[1] ?? "";
}

function check(name, ok, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
    return ok;
}

async function stageTree(sandbox, hostRoot, guestRoot) {
    const entries = await readdir(hostRoot, { withFileTypes: true });
    for (const entry of entries) {
        const hostPath = path.join(hostRoot, entry.name);
        const guestPath = `${guestRoot}/${entry.name}`;
        if (entry.isDirectory()) {
            await sandbox.fs.mkdir(guestPath, { recursive: true });
            await stageTree(sandbox, hostPath, guestPath);
        } else if (entry.isFile()) {
            await sandbox.fs.writeFile(guestPath, await readFile(hostPath));
        }
    }
}

async function run(sandbox, command, args, quiet = false) {
    const out = await sandbox.command(command, args).run({ check: false, timeoutMs: 120000 });
    const stdout = out.stdout.text();
    const stderr = out.stderr.text();
    if (!quiet && stdout) process.stdout.write(stdout);
    if (!quiet && stderr) process.stderr.write(stderr);
    return { exitCode: out.exitCode, stdout, stderr };
}

const wasmer = new Wasmer();
let sandbox;
let failures = 0;
const output = await mkdtemp(path.join(os.tmpdir(), "cuda-shim-test-"));
try {
    const packageDefinition = await wasmer.packages.create({
        modules: { llvm: await readFile(driver) },
        commands: {
            "clang": { module: "llvm" },
            "clang++": { module: "llvm" },
            "clang-offload-bundler": { module: "llvm" },
            "llvm-objdump": { module: "llvm" },
            "lld": { module: "llvm" },
            "wasm-ld": { module: "llvm" },
        },
        entrypoint: "clang++",
    });
    sandbox = await wasmer.sandboxes.create({ packages: [packageDefinition] });
    let kernelSymbol = process.env.KERNEL_SYMBOL ?? "";
    if (kernelSymbol === "") {
        const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
        const byStem = (candidate) => candidate.id === srcStem
            || (typeof candidate.file === "string" && candidate.file.replace(/\.cu$/, "") === srcStem);
        const entry = (manifest.fixtures ?? []).find(byStem) ?? (manifest.examples ?? []).find(byStem);
        kernelSymbol = entry?.kernel ?? "";
        if (kernelSymbol === "" && !check(`manifest declares a kernel symbol for ${srcStem}`, false, "pass KERNEL_SYMBOL= to override")) failures++;
    }
    await sandbox.fs.mkdir("/workspace", { recursive: true });
    await sandbox.fs.mkdir("/workspace/shim/include", { recursive: true });
    await sandbox.fs.mkdir("/workspace/resource", { recursive: true });
    await sandbox.fs.mkdir("/workspace/sysroot", { recursive: true });
    await sandbox.fs.writeFile(`/workspace/${srcStem}.cu`, await readFile(path.join(import.meta.dirname, "..", "cuda", srcName)));
    await sandbox.fs.writeFile("/workspace/unsupported-atomic.cu", await readFile(path.join(import.meta.dirname, "..", "cuda", "unsupported-atomic.cu")));
    const bundlerHelp = await run(sandbox, "clang-offload-bundler", ["--help"], true);
    if (!check("clang-offload-bundler is available", bundlerHelp.exitCode === 0, `exit=${bundlerHelp.exitCode}`)) failures++;
    await stageTree(sandbox, shim, "/workspace/shim/include");
    await stageTree(sandbox, resource, "/workspace/resource");
    await stageTree(sandbox, sysroot, "/workspace/sysroot");
    await sandbox.fs.writeFile("/workspace/header-test.c", `#include "cuda_runtime.h"
#ifndef __CUDA_FP32_ONLY__
#error __CUDA_FP32_ONLY__ is required
#endif
static cudaError_t (*launch)(const void *, dim3, dim3, void **, size_t, cudaStream_t) = cudaLaunchKernel;
int main(void) { return __CUDA_FP32_ONLY__ != 1 || launch == 0; }
`);

    const cHeader = await run(sandbox, "clang", [
        "--target=wasm32-wasi",
        "-std=c11",
        "-resource-dir", "/workspace/resource",
        "-isysroot", "/workspace/sysroot",
        "-isystem", "/workspace/sysroot/include",
        "-I", "/workspace/shim/include",
        "-c", "/workspace/header-test.c",
        "-o", "/workspace/header-test.o",
    ]);
    if (!check("C header contract compiles", cHeader.exitCode === 0, `exit=${cHeader.exitCode}`)) failures++;

    const common = [
        "-x", "hip",
        "-std=c++17",
        "-nogpulib",
        "-nostdinc++",
        "-resource-dir", "/workspace/resource",
        "-isysroot", "/workspace/sysroot",
        "-isystem", "/workspace/sysroot/include",
        "-Xclang", "-internal-isystem",
        "-Xclang", "/workspace/sysroot/include/c++/v1",
        "-I", "/workspace/shim/include",
        "-include", "cuda_runtime.h",
    ];
    const device = await run(sandbox, "clang++", [
        "-cc1",
        "-triple", "amdgcn-amd-amdhsa",
        "-target-cpu", "gfx803",
        "-emit-obj",
        "-x", "hip",
        "-std=c++17",
        "-nogpulib",
        "-nostdinc++",
        "-resource-dir", "/workspace/resource",
        "-isysroot", "/workspace/sysroot",
        "-isystem", "/workspace/sysroot/include",
        "-internal-isystem", "/workspace/sysroot/include/c++/v1",
        "-I", "/workspace/shim/include",
        "-include", "cuda_runtime.h",
        "-fcuda-is-device",
        "-fhip-new-launch-api",
        `/workspace/${srcStem}.cu`,
        "-o", `/workspace/${srcStem}-device.o`,
    ]);
    if (!check("device pass compiles", device.exitCode === 0, `exit=${device.exitCode}`)) {
        failures++;
    } else {
        const deviceData = await sandbox.fs.readFile(`/workspace/${srcStem}-device.o`);
        let codeObjectData = deviceData;
        if (deviceData[0] !== 0x7f || deviceData[1] !== 0x45 || deviceData[2] !== 0x4c || deviceData[3] !== 0x46) {
            const bundler = await run(sandbox, "clang-offload-bundler", [
                "--type=o",
                "--unbundle",
                `--inputs=/workspace/${srcStem}-device.o`,
                "--targets=hipv4-amdgcn-amd-amdhsa--gfx803",
                `--outputs=/workspace/${srcStem}.co`,
            ]);
            if (!check("device object unbundles", bundler.exitCode === 0, `exit=${bundler.exitCode}`)) {
                failures++;
                codeObjectData = null;
            } else {
                codeObjectData = await sandbox.fs.readFile(`/workspace/${srcStem}.co`);
            }
        } else {
            check("device pass emits an ELF code object", true);
        }
        if (codeObjectData) {
            const codeObject = path.join(output, `${srcStem}.co`);
            await writeFile(codeObject, codeObjectData);
            const symbols = spawnSync("nm", ["-g", codeObject], { encoding: "utf8" });
            const symbolText = `${symbols.stdout}${symbols.stderr}`;
            if (!check("device nm succeeds", symbols.status === 0, symbols.error?.message ?? `exit=${symbols.status}`)) {
                failures++;
            } else {
                const sharedMemoryKernelLine = matchingLine(symbolText, /^\s*[0-9a-f]+\s+T\s+sharedMemoryKernel$/);
                const sharedMemoryDescriptorLine = matchingLine(symbolText, /^\s*[0-9a-f]+\s+\S+\s+sharedMemoryKernel\.kd$/);
                if (kernelSymbol !== "") {
                    const symbolLine = matchingLine(symbolText, new RegExp(`^\\s*[0-9a-f]+\\s+T\\s+${kernelSymbol}$`));
                    const descriptorLine = matchingLine(symbolText, new RegExp(`^\\s*[0-9a-f]+\\s+\\S+\\s+${kernelSymbol}\\.kd$`));
                    if (!check(`device ${kernelSymbol} symbol is unmangled`, symbolLine !== "", symbolLine)) failures++;
                    if (!check(`device ${kernelSymbol} descriptor is present`, descriptorLine !== "", descriptorLine)) failures++;
                }
                if (!check("device shared-memory kernel symbol is unmangled", sharedMemoryKernelLine !== "", sharedMemoryKernelLine)) failures++;
                if (!check("device shared-memory descriptor is present", sharedMemoryDescriptorLine !== "", sharedMemoryDescriptorLine)) failures++;
                const disassembly = await run(sandbox, "llvm-objdump", ["--disassemble", `/workspace/${srcStem}-device.o`], true);
                if (!check("device disassembly succeeds", disassembly.exitCode === 0, `exit=${disassembly.exitCode}`)) {
                    failures++;
                }
            }
        }
    }

    const atomicDevice = await run(sandbox, "clang++", [
        "-cc1",
        "-triple", "amdgcn-amd-amdhsa",
        "-target-cpu", "gfx803",
        "-emit-obj",
        "-x", "hip",
        "-std=c++17",
        "-nogpulib",
        "-nostdinc++",
        "-resource-dir", "/workspace/resource",
        "-isysroot", "/workspace/sysroot",
        "-isystem", "/workspace/sysroot/include",
        "-internal-isystem", "/workspace/sysroot/include/c++/v1",
        "-I", "/workspace/shim/include",
        "-include", "cuda_runtime.h",
        "-fcuda-is-device",
        "-fhip-new-launch-api",
        "/workspace/unsupported-atomic.cu",
        "-o", "/workspace/unsupported-atomic-device.o",
    ]);
    const atomicDiagnostics = `${atomicDevice.stdout}${atomicDevice.stderr}`;
    // Read from boundaries.json rather than written here: a hand-written copy would
    // be a second place the cuda_runtime.h static_assert could go stale.
    const atomicBoundary = boundaries.find((candidate) => candidate.id === "atomics");
    if (atomicBoundary === undefined) {
        if (!check("boundaries.json declares the atomics boundary", false, `no row with id "atomics"`)) failures++;
    } else if (!check("atomic device pass is rejected", atomicDevice.exitCode !== 0 && atomicBoundary.message.length > 0 && atomicDiagnostics.includes(atomicBoundary.message), `exit=${atomicDevice.exitCode}`)) {
        failures++;
        process.stdout.write(atomicDiagnostics);
    }

    const host = await run(sandbox, "clang++", [
        ...common,
        "--target=wasm32-wasi",
        "--offload-host-only",
        "-pthread",
        "-c", `/workspace/${srcStem}.cu`,
        "-o", `/workspace/${srcStem}-host.o`,
    ]);
    if (!check("host pass compiles", host.exitCode === 0, `exit=${host.exitCode}`)) {
        failures++;
    } else {
        const hostObject = path.join(output, `${srcStem}-host.o`);
        const data = await sandbox.fs.readFile(`/workspace/${srcStem}-host.o`);
        await writeFile(hostObject, data);
        const symbols = spawnSync("nm", ["-u", hostObject], { encoding: "utf8" });
        const symbolText = `${symbols.stdout}${symbols.stderr}`;
        if (!check("host nm succeeds", symbols.status === 0, symbols.error?.message ?? `exit=${symbols.status}`)) {
            failures++;
        } else {
            for (const symbol of hostRuntimeSymbols) {
                const symbolLine = matchingLine(symbolText, new RegExp(`^\\s*U\\s+${symbol}$`));
                if (!check(`host references ${symbol}`, symbolLine !== "", symbolLine)) failures++;
            }
            const link = await run(sandbox, "wasm-ld", [
                `/workspace/${srcStem}-host.o`,
                "-o", `/workspace/${srcStem}-host.wasm`,
                "--allow-undefined",
                "--no-entry",
                "--export=main",
            ]);
            if (!check("host links with the production wasm-ld flags", link.exitCode === 0, `exit=${link.exitCode}`)) {
                failures++;
            } else {
                const hostWasm = path.join(output, `${srcStem}-host.wasm`);
                await writeFile(hostWasm, await sandbox.fs.readFile(`/workspace/${srcStem}-host.wasm`));
                const printed = spawnSync("wasm-tools", ["print", hostWasm], { encoding: "utf8" });
                if (!check("host WASM can be inspected", printed.status === 0, printed.error?.message ?? `exit=${printed.status}`)) {
                    failures++;
                } else {
                    const wat = printed.stdout;
                    const importEntries = [...wat.matchAll(/^\s*\(import "([^"]+)" "([^"]+)" \((\w+)/gm)]
                        .map((match) => ({ module: match[1], name: match[2], kind: match[3] }));
                    const actual = new Map(importEntries.filter((entry) => entry.kind === "func").map((entry) => [entry.name, entry.module]));
                    const expected = new Map(Object.keys(wasmSignatures).map((name) => [name, "env"]));
                    const missing = [...expected.keys()].filter((name) => !actual.has(name));
                    const unexpected = [...actual.keys()].filter((name) => !expected.has(name));
                    const wrongModule = [...expected].filter(([name, module]) => actual.get(name) !== module).map(([name]) => name);
                    const nonFunctionImports = importEntries.filter((entry) => entry.kind !== "func");
                    const exactSet = missing.length === 0 && unexpected.length === 0 && wrongModule.length === 0 && actual.size === expected.size && importEntries.length === expected.size && nonFunctionImports.length === 0;
                    if (!check("host WASM import set is exact", exactSet, `missing=${missing.join(",")} unexpected=${unexpected.join(",")} wrongModule=${wrongModule.join(",")}`)) failures++;
                    const wrongSignatures = Object.entries(wasmSignatures).filter(([name, signature]) => {
                        const index = wasmFunctionIndex(wat, "import", name);
                        return index === "" || wasmTypeSignature(wat, index) !== signature;
                    }).map(([name]) => {
                        const index = wasmFunctionIndex(wat, "import", name);
                        return `${name}:${index}:${wasmTypeSignature(wat, index)}`;
                    });
                    if (!check("host WASM import signatures are exact", wrongSignatures.length === 0, `wrong=${wrongSignatures.join(",")}`)) failures++;
                    const mainType = wasmFunctionIndex(wat, "export", "main");
                    if (!check("host WASM exports WASI main", mainType !== "" && wasmTypeSignature(wat, mainType) === mainSignature, wasmTypeSignature(wat, mainType))) failures++;
                    if (!check("host WASM runs module constructors before main", /func \$main\.command_export[\s\S]*call \$__wasm_call_ctors[\s\S]*call \$main/.test(wat))) failures++;
                }
            }
        }
    }
} catch (error) {
    failures++;
    console.error("FAIL: test harness", error?.message ?? error);
} finally {
    await sandbox?.close().catch(() => {});
    await wasmer?.close().catch(() => {});
    await rm(output, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
}
console.log("\nAll CUDA shim compile tests passed");
