#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const [dumpPath, sourcePath] = process.argv.slice(2);
if (!dumpPath || !sourcePath) {
    process.stderr.write("usage: check-fp32.mjs <clang-token-dump> <source.cu>\n");
    process.exit(2);
}

const dump = await readFile(dumpPath, "utf8");
const guestSource = `/workspace/${path.basename(sourcePath)}`;
const sourceLines = dump.split(/\r?\n/).filter((line) => line.includes(`Loc=<${guestSource}:`));
const doubleToken = sourceLines.find((line) => /raw_identifier 'double'/.test(line));
const doubleLiteral = sourceLines.find((line) => {
    const match = line.match(/numeric_constant '([^']+)'/);
    if (!match) return false;
    const value = match[1];
    return /^(?:\d|0[xX])/i.test(value) && /[.ep]/i.test(value) && !/[fF]$/.test(value);
});
const offendingLine = doubleToken ?? doubleLiteral;
if (offendingLine) {
    const line = offendingLine.match(/:(\d+):\d+>$/)?.[1] ?? "unknown";
    process.stderr.write(`check-fp32: HIP playground v1 is float32-only: fp64 is not supported (${sourcePath}:${line})\n`);
    process.exit(1);
}
