#!/usr/bin/env node
// Behavioural coverage for the target a compile.sh invocation emits. Asserts on
// the code object rather than the script's text: the offload bundle stamps the
// ISA it was built for, so the artifact says which target the driver received.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { defaultToolchain, toolchains } from "../../src/scripts/toolchain-registry.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const compileSh = path.join(root, "src", "scripts", "compile.sh");
const fixture = path.join(import.meta.dirname, "..", "cuda", "vectoradd.cu");
// Printable-ASCII run, so the match stops at the NUL ending the bundle's
// target string instead of running through it into the surrounding binary.
const bundleIsa = /amdgcn-amd-amdhsa--([!-~]+)/;

let failures = 0;

function check(name, ok, detail = "") {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
    if (!ok) failures++;
    return ok;
}

// compile.sh's whole interface: source, then outDir/arch/toolchainId.
function compile(outDir, arch, toolchainId) {
    const result = spawnSync(compileSh, [fixture, outDir, ...(arch === undefined ? [] : [arch]), ...(toolchainId === undefined ? [] : [toolchainId])], { cwd: root, encoding: "utf8" });
    return { ...result, diagnostics: `${result.stdout}${result.stderr}` };
}

async function emittedIsa(codeObjectPath) {
    const data = await readFile(codeObjectPath);
    return data.toString("latin1").match(bundleIsa)?.[1] ?? "";
}

const registryDefault = defaultToolchain();
const output = await mkdtemp(path.join(os.tmpdir(), "cuda-shim-target-"));
try {
    // Must be the arch `make compile` falls back to, or the two builds disagree.
    const defaultDir = path.join(output, "registry-default");
    const registered = compile(defaultDir, registryDefault.defaultArch);
    if (check(`compile succeeds for the registry default arch (${registryDefault.defaultArch})`, registered.status === 0, `exit=${registered.status}`)) {
        const isa = await emittedIsa(path.join(defaultDir, "device.co"));
        check(`the registry default arch emits ${registryDefault.defaultArch}`, isa === registryDefault.defaultArch, `emitted=${isa}`);
    } else {
        process.stdout.write(registered.diagnostics);
    }

    // The arch the caller passes is the ISA the driver is handed, and it reaches the
    // artifact.
    const otherArch = registryDefault.defaultArch === "gfx900" ? "gfx1030" : "gfx900";
    const targetedDir = path.join(output, otherArch);
    const targeted = compile(targetedDir, otherArch);
    if (check(`compile succeeds for ${otherArch}`, targeted.status === 0, `exit=${targeted.status}`)) {
        const isa = await emittedIsa(path.join(targetedDir, "device.co"));
        check(`${otherArch} emits ${otherArch}`, isa === otherArch, `emitted=${isa}`);
    } else {
        process.stdout.write(targeted.diagnostics);
    }

    // Quoting canary: an unquoted expansion would word-split into a valid gfx900 and
    // compile; as one argument clang rejects it as an unknown target CPU.
    const splitDir = path.join(output, "split");
    const split = compile(splitDir, `${registryDefault.defaultArch} gfx900`);
    check(
        "a target arch with a space is rejected as one argument",
        split.status !== 0 && split.diagnostics.includes("unknown target CPU"),
        `exit=${split.status}`,
    );
    if (split.status === 0) process.stdout.write(split.diagnostics);

    // The arch is required; there is no default to fall back on.
    const usage = spawnSync(compileSh, [fixture, path.join(output, "no-arch")], { cwd: root, encoding: "utf8" });
    check(
        "an omitted arch is a usage error, not a default target",
        usage.status !== 0 && `${usage.stdout}${usage.stderr}`.includes("usage:"),
        `exit=${usage.status}`,
    );

    // A toolchain id is a registry key, so a typo fails here.
    const unknownToolchain = compile(path.join(output, "unknown-toolchain"), registryDefault.defaultArch, "no-such-toolchain");
    check(
        "an unknown toolchain id is rejected by name",
        unknownToolchain.status !== 0 && unknownToolchain.diagnostics.includes(`unknown toolchain "no-such-toolchain"`),
        `exit=${unknownToolchain.status}`,
    );

    // The id every device resolves through.
    const namedDir = path.join(output, "named");
    const named = compile(namedDir, registryDefault.defaultArch, registryDefault.id);
    check(
        `compile succeeds when the registry's own toolchain id is named (${registryDefault.id})`,
        named.status === 0,
        `exit=${named.status}`,
    );
    if (named.status !== 0) process.stdout.write(named.diagnostics);

    // Every device the toolchain claims must resolve to an arch.
    for (const [deviceId, arch] of Object.entries(registryDefault.devices ?? {})) {
        check(`device ${deviceId} resolves to ${arch} in the registry`, typeof arch === "string" && arch !== "");
    }

    // And every toolchain a device could name must be a row here.
    for (const row of toolchains()) {
        check(`toolchain ${row.id} names a driver and a triple`, typeof row.driverFile === "string" && typeof row.triple === "string");
    }
} finally {
    await rm(output, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} compile-target test(s) FAILED`);
    process.exit(1);
}
console.log("\nAll CUDA shim compile-target tests passed");