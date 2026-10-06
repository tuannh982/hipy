#!/usr/bin/env node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { defaultToolchain } from "../../src/scripts/toolchain-registry.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const fixturePath = (name) => path.join(import.meta.dirname, "..", "cuda", name);
// Messages are matched as substrings: several diagnostics carry a trailing clause
// (source path, kernel name) the table does not quote. What is pinned is the
// stable identifying prefix, so rewording the suffix does not fail this suite.
const { boundaries } = JSON.parse(await readFile(path.join(root, "boundaries.json"), "utf8"));
// compile.sh requires the ISA as an argument, so name the registry default here.
const defaultArch = defaultToolchain().defaultArch;
const cases = boundaries
    .filter((boundary) => boundary.phase === "compile")
    .map((boundary) => [boundary.fixture, boundary.message]);
let failures = 0;
const output = await mkdtemp(path.join(os.tmpdir(), "cuda-shim-negative-"));
const cudaDir = path.join(import.meta.dirname, "..", "cuda");

try {
    // Reverse guard: a boundary the shim enforces but the table omits would be
    // unrendered in the About tab and green here.
    const listedFixtures = new Set(boundaries.map((boundary) => boundary.fixture));
    const unlisted = (await readdir(cudaDir))
        .filter((name) => name.startsWith("unsupported-") && name.endsWith(".cu"))
        .filter((name) => !listedFixtures.has(name))
        .sort();
    if (unlisted.length === 0) {
        console.log("PASS: every unsupported-*.cu fixture in tests/cuda is a row in boundaries.json");
    } else {
        console.log(`FAIL: ${unlisted.length} fixture(s) in tests/cuda have no row in boundaries.json`);
        for (const name of unlisted) {
            console.error(
                `${name}: add a boundaries.json row with "fixture": "${name}", the "label" and "detail" a reader needs, ` +
                '"phase": "compile", and a "message" copied from the #error/static_assert the header or check script emits ' +
                "-- not reworded from memory. Run this suite and let it tell you if the message is not a substring of the real diagnostic.",
            );
        }
        failures++;
    }

    for (const [fixture, expected] of cases) {
        // `includes("")` is true, so an empty message would pass for any failure at all.
        if (expected.length === 0) {
            console.log(`FAIL: ${fixture} has an empty message, so its row asserts nothing`);
            failures++;
            continue;
        }
        const result = spawnSync(path.join(root, "src", "scripts", "compile.sh"), [fixturePath(fixture), output, defaultArch], {
            cwd: root,
            encoding: "utf8",
        });
        const diagnostics = `${result.stdout}${result.stderr}`;
        const rejected = result.status !== 0 && diagnostics.includes(expected);
        console.log(`${rejected ? "PASS" : "FAIL"}: ${fixture} is rejected with the playground diagnostic`);
        if (!rejected) {
            failures++;
            process.stdout.write(diagnostics);
        }
    }

    const goodEntry = (await readdir(cudaDir))
        .filter((name) => name.endsWith(".cu") && !name.startsWith("unsupported-"))
        .sort()[0];
    if (!goodEntry) {
        console.log("FAIL: no good-compile fixture found in tests/cuda");
        failures++;
    }
    const good = goodEntry
        ? spawnSync(path.join(root, "src", "scripts", "compile.sh"), [fixturePath(goodEntry), output, defaultArch], {
            cwd: root,
            encoding: "utf8",
        })
        : { status: 1, stdout: "", stderr: "no good-compile fixture" };
    const goodDiagnostics = `${good.stdout}${good.stderr}`;
    const goodArtifacts = ["device.co", "host.o", "host.wasm"].filter((name) => goodDiagnostics.includes(name));
    const goodOk = good.status === 0 && goodArtifacts.length === 3;
    console.log(`${goodOk ? "PASS" : "FAIL"}: good compile produces all three artifacts before stale-artifact regression`);
    if (!goodOk) {
        failures++;
        process.stdout.write(goodDiagnostics);
    }

    // The launch boundary is rejected by the harness at launch, not by the
    // compiler, so this greps wasmexec/exports.go for the message. That is a
    // claim about the string in the file, not a run.
    const launchBoundaries = boundaries.filter((boundary) => boundary.phase === "launch");
    if (launchBoundaries.length === 0) {
        console.log("FAIL: boundaries.json declares no launch-phase boundary");
        failures++;
    } else {
        // Every launch row, not just the first.
        const exportsSource = await readFile(
            path.resolve(root, "..", "simulator", "wasmexec", "exports.go"),
            "utf8",
        );
        for (const boundary of launchBoundaries) {
            // A launch row's fixture is empty (no .cu exercises this path), and an empty
            // message would satisfy this grep and log a PASS about a diagnostic
            // nobody wrote down.
            const agrees = boundary.fixture === ""
                && boundary.message.length > 0
                && exportsSource.includes(boundary.message);
            console.log(
                `${agrees ? "PASS" : "FAIL"}: grep -- the launch boundary "${boundary.label}" is written in wasmexec/exports.go and names no fixture this suite skips (source text, not a run)`,
            );
            if (!agrees) {
                failures++;
                console.error(`looked for: ${boundary.message} (fixture: ${boundary.fixture || "none"})`);
            }
        }
    }

    const rejected = spawnSync(path.join(root, "src", "scripts", "compile.sh"), [fixturePath("unsupported-fp64.cu"), output, defaultArch], {
        cwd: root,
        encoding: "utf8",
    });
    const remaining = (await readdir(output)).filter((name) => ["device.co", "host.o", "host.wasm"].includes(name));
    const noStaleArtifacts = rejected.status !== 0 && remaining.length === 0;
    console.log(`${noStaleArtifacts ? "PASS" : "FAIL"}: rejected compile leaves no usable artifacts in the reused output directory`);
    if (!noStaleArtifacts) {
        failures++;
        process.stdout.write(`${rejected.stdout}${rejected.stderr}`);
        console.error(`remaining artifacts: ${remaining.join(",")}`);
    }
} finally {
    await rm(output, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} compile-failure test(s) FAILED`);
    process.exit(1);
}
console.log("\nAll CUDA shim compile-failure tests passed");
