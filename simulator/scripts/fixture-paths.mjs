#!/usr/bin/env node
// Prints "<source> <codeObject>" for one entry of testdata/fixtures.json, both
// prefixed with testdata/, so the fixture Makefile target takes its defaults
// from the manifest instead of restating them. With no argument, uses the
// first entry. Used as:
//
//   read -r src out < <(scripts/fixture-paths.mjs [id])
//
// A fixture whose manifest entry records `"source": null` has no source in the
// tree and cannot be rebuilt; the Makefile target then requires explicit
// SRC= and OUT= overrides.
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../testdata/fixtures.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const fixtures = manifest.fixtures ?? [];
const id = process.argv[2];

if (fixtures.length === 0) {
  fail(`${manifestUrl.pathname} declares no fixtures`);
}

let fixture;
if (id === undefined || id === "") {
  fixture = fixtures[0];
} else {
  fixture = fixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) {
    fail(`no fixture id "${id}" in ${manifestUrl.pathname} (have ${fixtures.map((f) => f.id).join(", ")})`);
  }
}

if (typeof fixture.source !== "string" || fixture.source === "") {
  fail(`fixture "${fixture.id}" declares no source in ${manifestUrl.pathname}; pass SRC= and OUT= explicitly`);
}
if (typeof fixture.codeObject !== "string" || fixture.codeObject === "") {
  fail(`fixture "${fixture.id}" declares no codeObject in ${manifestUrl.pathname}`);
}

process.stdout.write(`testdata/${fixture.source} testdata/${fixture.codeObject}\n`);

function fail(message) {
  process.stderr.write(`fixture-paths: ${message}\n`);
  process.exit(1);
}
