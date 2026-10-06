// The toolchain registry (toolchains.json), read once and shared by the Node
// scripts under this tree and by website/toolchains.ts.
import { readFileSync } from "node:fs";
import path from "node:path";

export const REGISTRY_PATH = path.resolve(import.meta.dirname, "..", "..", "toolchains.json");

/** Every toolchain row, in file order. */
export function toolchains() {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")).toolchains ?? [];
}

/**
 * One row by id, or throw naming the known set.
 *
 * Throwing rather than returning undefined keeps a missing toolchain loud on
 * every caller, which is on a build or test path.
 */
export function toolchain(id) {
    const found = toolchains().find((row) => row.id === id);
    if (!found) {
        throw new Error(`unknown toolchain "${id}"; known toolchains: ${toolchains().map((row) => row.id).join(", ")}`);
    }
    return found;
}

/**
 * The single default toolchain, or throw while there is more than one. The check
 * is on the count rather than on a declared flag.
 */
export function defaultToolchain() {
    const all = toolchains();
    if (all.length !== 1) {
        throw new Error(`no single default toolchain among [${all.map((row) => row.id).join(", ")}]; name one`);
    }
    return all[0];
}

/** The ISA a device compiles for, or throw naming what this toolchain claims. */
export function deviceArch(id, deviceId) {
    const row = toolchain(id);
    const arch = row.devices?.[deviceId];
    if (arch === undefined) {
        throw new Error(`toolchain "${row.id}" claims no device "${deviceId}"; it claims ${Object.keys(row.devices ?? {}).join(", ") || "none"}`);
    }
    return arch;
}