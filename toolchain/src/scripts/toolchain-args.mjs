#!/usr/bin/env node
// Prints one field of toolchains.json, so the shell build path reads the same
// registry the browser does.
//
//   usage: toolchain-args.mjs <toolchain-id|-> <field> [device-id]
//
// "-" resolves the default: the sole entry while there is one toolchain, an
// error naming the known set as soon as there is not.
//
//   id=$(toolchain-args.mjs - id)                     # the default toolchain's id
//   triple=$(toolchain-args.mjs "$id" triple)         # the OS/ABI triple
//   arch=$(toolchain-args.mjs "$id" defaultArch)      # its fallback ISA
//   arch=$(toolchain-args.mjs - arch gcn3generic)     # the ISA a device compiles for
//   IFS=$'\n' read -d '' -a flags < <(toolchain-args.mjs "$id" devicePassArgs)
//
// An array prints one element per line and a string prints itself, so a caller can
// take it as `$(...)` or split it on newlines (bash 3.2 has no mapfile). Failures
// exit non-zero with the reason on stderr, never a fallback.
import { defaultToolchain, deviceArch, toolchain } from "./toolchain-registry.mjs";

const [, , requestedId, field, deviceId] = process.argv;

if (!requestedId || !field) {
    console.error("usage: toolchain-args.mjs <toolchain-id|-> <field> [device-id]");
    process.exit(2);
}

try {
    if (field === "id") {
        process.stdout.write(`${defaultToolchain().id}\n`);
    } else {
        const row = requestedId === "-" ? defaultToolchain() : toolchain(requestedId);
        if (field === "arch") {
            if (!deviceId) throw new Error('field "arch" needs a device id: toolchain-args.mjs <toolchain-id> arch <device-id>');
            process.stdout.write(`${deviceArch(row.id, deviceId)}\n`);
        } else {
            const value = row[field];
            if (value === undefined) throw new Error(`toolchain "${row.id}" has no field "${field}"`);
            process.stdout.write(`${Array.isArray(value) ? value.join("\n") : value}\n`);
        }
    }
} catch (error) {
    console.error(`toolchain-args: ${error.message}`);
    process.exit(1);
}

