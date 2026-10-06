// The editor's contribution imports.
//
// This exists because of a bug that looked like working code.
//
// `monaco-editor/editor/editor.api` is the API surface ALONE: it pulls in zero
// editor contributions -- no hover, no suggest, no find, no go-to-definition, no
// links, no parameter hints, no context menu, no snippet expansion. Every language
// feature in this editor was registered into a service registry that had no
// consumer for it. The providers were called by nothing, F12 and Ctrl+click had
// no handler behind them, and Ctrl+F did nothing -- while the source read exactly
// as though it worked.
//
// Nothing in the test suite could have caught that, and nothing about the build
// failed. So this asserts the wiring explicitly: the features the editor
// registers, and the contribution each one needs to have a consumer at all.
//
// It is a source-level test on purpose. The alternative -- instantiating Monaco in
// Node and asking the registry what it has -- needs a DOM, and a test that cannot
// run is a test that will not be run.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const editorPath = path.join(repoRoot, "website", "src", "editor", "CudaEditor.tsx");
const source = fs.readFileSync(editorPath, "utf8");
const { CUDA_SNIPPETS } = await tsImport(
  path.join(repoRoot, "website", "src", "lib", "cudaLanguage.ts"),
  import.meta.url,
);

/** The contrib modules imported for side effects, as `contrib/<name>`. */
function importedContributions() {
  return [...source.matchAll(/import "monaco-editor\/editor\/contrib\/([a-zA-Z]+)\//g)].map((m) => m[1]);
}

const imported = new Set(importedContributions());

test("every contribution the editor's features need is imported", () => {
  // Each row is a feature registered above, and the contribution that gives that
  // feature something to run inside. A missing entry is not a lint: it is a
  // feature that silently does nothing, which is the bug this file is about.
  const required = [
    ["hover", "the hover provider, which renders nothing without a hover widget"],
    ["suggest", "the completion provider, which is called by the suggest widget"],
    ["parameterHints", "the signature-help provider"],
    ["gotoError", "F12 and Shift+F12: go to definition and find references"],
    ["links", "Ctrl+click, which is a different code path from F12"],
    ["snippet", "the completion snippets; without it ${1:tabstop} is inserted literally"],
    ["contextmenu", "the Find in Code entry, which lives in the context menu"],
    ["find", "Ctrl+F and Ctrl+H, which the find widget owns"],
  ];
  for (const [name, why] of required) {
    assert.ok(imported.has(name), `contrib/${name} is not imported, so ${why}`);
  }
});

test("the editor registers the features those contributions serve", () => {
  // The other direction. A contribution imported for a feature that was then
  // deleted is bundle weight for nothing, and the pairing above is what keeps the
  // two lists honest about each other.
  for (const [provider, contribution] of [
    ["registerHoverProvider", "hover"],
    ["registerCompletionItemProvider", "suggest"],
    ["registerSignatureHelpProvider", "parameterHints"],
    ["registerDefinitionProvider", "gotoError"],
  ]) {
    assert.match(source, new RegExp(provider), `${provider} is not defined`);
    assert.ok(imported.has(contribution), `contrib/${contribution} is missing for ${provider}`);
  }
  assert.match(source, /registerReferenceProvider/, "no reference provider, so Shift+F12 has nothing to answer with");
});

test("editor.api is imported for its types and not for its features", () => {
  // The API module and the contributions are separate imports on purpose: the API
  // module is the only one with TypeScript declarations, and it is the one that
  // carries no features. If someone "simplifies" this to a single bare
  // `monaco-editor` import the bundle grows by ~190 KB gzipped, and if someone
  // drops the contribution imports every feature in this editor dies again.
  assert.match(source, /import \* as monaco from "monaco-editor\/editor\/editor\.api"/);
  assert.ok(
    !/^import "monaco-editor";$/m.test(source),
    "a bare `monaco-editor` import would pull every contribution Monaco ships",
  );
  assert.match(source, /contrib\/hover/, "the side-effect contribution imports are gone");
});

test("every imported contribution resolves to a real file", () => {
  // A renamed module inside Monaco fails the build loudly, which is the point of
  // using side-effect imports rather than reimplementing these. Asserted here too
  // because the failure is otherwise only visible at build time, and a build is
  // not always what someone is running.
  const contribRoot = path.join(repoRoot, "website", "node_modules", "monaco-editor", "esm", "vs", "editor", "contrib");
  const paths = [...source.matchAll(/import "(monaco-editor\/editor\/contrib\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 8, `only ${paths.length} contribution imports found`);
  for (const specifier of paths) {
    const relative = specifier.replace("monaco-editor/", "");
    const resolved = path.join(repoRoot, "website", "node_modules", "monaco-editor", "esm", "vs", relative);
    assert.ok(fs.existsSync(`${resolved}.js`), `${specifier} does not resolve to a file`);
  }
});

test("the snippets carry tabstops the snippet controller can expand", () => {
  // A `${1:...}` that is never expanded is inserted as literal text, which is the
  // whole value of a snippet. This is the assertion that would have caught the
  // missing contrib if it had been written before the bug was found.
  for (const snippet of CUDA_SNIPPETS) {
    assert.match(snippet.insert, /\$\{\d+:/, `the "${snippet.label}" snippet has no tabstop`);
  }
});
