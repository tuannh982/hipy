// Class audit: every class a component uses must have a rule, and no rule may be
// dead. A script rather than a test on purpose -- see the closing note.
//
// Three shapes of className appear in this repo and each needs different handling:
//   className="a b"            -> the body is the class string
//   className={`a b ${x}`}     -> the body is a template literal; strip ${...}
//   className={`stage-${s}`}   -> a dynamic CLASS NAME. The concrete names come
//                                  from a lookup elsewhere, so a class-position
//                                  prefix before the ${ is recorded as a prefix
//                                  and any ruled class under it counts as used.
// Not expanding dynamic prefixes reports every stage-*/console-* rule as dead,
// which is the failure mode that makes an audit get ignored.
//
// The className={...} body is found by brace-balanced scanning, not by regex:
// a body like `${stage}` closes its own brace early, so `\{([^}]*)\}` truncates
// it and silently finds no classes at all.
//
// This is NOT in the suite. It parses JSX with regexes, which is fine for a tool
// you run by hand before a commit that renames a class and not fine for a check
// that has to be right every time: it would eventually fail a good commit on a
// false positive, and then it would be skipped or deleted. The direction it is
// sound in -- "no rule is dead", for every class outside a dynamic prefix -- is
// what a reviewer can use by reading the report, which is what this is for.
//
// What this cannot do is check the dynamic prefixes, and that is the hole
// tests/stage-styles.test.mjs closes for the Stage union: a stage added to the
// union with no .stage-<s> rule still audits clean, because the prefix counts.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..", "src");

// Classes a component emits that are deliberately unruled, each with the reason.
// One entry, and it is a marker: `crowded` says the column is conflicted, which
// the fill already says, and its depth and its 0.9 opacity are set inline from
// LDS_PALETTE, so any rule for it restated what the component already sent. The
// class is worth keeping in the markup for a reader of the DOM, which is why it
// is excused here rather than deleted from LdsInspector.
const UNRULED = new Map([
  ["crowded", "LdsInspector.tsx marks the conflicted bank column; fill and opacity are inline"],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// Brace-balanced scan of a JSX attribute value starting at index i (which must be
// `{`). Returns the inner body.
function scanBraced(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(i + 1, j);
    }
  }
  return null;
}

// Every string literal in a JSX attribute body: "a", 'a', and `a ${x} b`. A
// template literal's own ${...} regions are kept in the raw text and searched
// again for quoted literals, because the ternaries that pick a class live there.
// Returns both the literals and the raw template spans, because only the raw span
// still shows where a dynamic class name starts.
function literalsIn(body, raws = []) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      const end = body.indexOf(ch, i + 1);
      if (end === -1) break;
      out.push(body.slice(i + 1, end));
      i = end;
    } else if (ch === "`") {
      let depth = 0;
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === "\\") j += 2;
        else if (body[j] === "$" && body[j + 1] === "{") { depth++; j += 2; }
        else if (body[j] === "}" && depth > 0) { depth--; j++; }
        else if (body[j] === "`" && depth === 0) break;
        else j++;
      }
      const span = body.slice(i + 1, j);
      raws.push(span);
      // Literal text outside every ${...}, with the interpolations as spaces so a
      // `stage-${stage}` splits into "stage-" and "". Built by walking span once:
      // substituting into `flat` while indexing into `span` desynchronises the two
      // after the first replacement and yields fragments like "telemetryTabs".
      let flat = "";
      let d = 0;
      while (d < span.length) {
        if (span[d] === "$" && span[d + 1] === "{") {
          let k = d + 2;
          let depth = 1;
          while (k < span.length && depth > 0) {
            if (span[k] === "{") depth++;
            else if (span[k] === "}") depth--;
            k++;
          }
          flat += " ";
          d = k;
        } else {
          flat += span[d];
          d++;
        }
      }
      out.push(flat, ...literalsIn(span, raws));
      i = j;
    }
  }
  return out;
}

const used = new Map(); // class -> [files]
const prefixes = new Map(); // dynamic class prefix -> [files]

function add(map, key, short) {
  if (!map.has(key)) map.set(key, []);
  if (!map.get(key).includes(short)) map.get(key).push(short);
}

for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const short = file.slice(SRC.length + 1);
  for (const m of text.matchAll(/className=(\{|"([^"]*)")/g)) {
    const raws = [];
    const bodies =
      m[2] !== undefined
        ? [m[2]]
        : (() => {
            const body = scanBraced(text, m.index + m[0].length - 1);
            return body === null ? [] : literalsIn(body, raws);
          })();
    // A dynamic class name: `stage-${stage}` is a prefix plus an interpolation,
    // and the concrete names come from a lookup elsewhere. Only the raw span can
    // say that, and only a part with a class before the ${ is a class at all.
    for (const span of raws) {
      for (const part of span.split(/\s+/)) {
        const at = part.indexOf("${");
        if (at > 0) add(prefixes, part.slice(0, at), short);
      }
    }
    for (const body of bodies) {
      for (const cls of body.split(/\s+/)) {
        // Drop interpolation leftovers and any expression text that survived the
        // literal scan, and drop a bare prefix already recorded as dynamic.
        if (!cls || cls.includes("$") || /[?&|=()]/.test(cls)) continue;
        if (prefixes.has(cls)) continue;
        add(used, cls, short);
      }
    }
  }
}

const css = readFileSync(join(SRC, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const ruled = new Map();
for (const m of css.matchAll(/(^|[{}])\s*([^{}]+)\{/g)) {
  for (const sel of m[2].split(",")) {
    const clean = sel.trim();
    if (!clean) continue;
    for (const c of clean.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      if (!ruled.has(c[1])) ruled.set(c[1], []);
      if (!ruled.get(c[1]).includes(clean)) ruled.get(c[1]).push(clean);
    }
  }
}

const preList = [...prefixes.keys()];
const covered = (cls) =>
  used.has(cls) || preList.some((p) => cls.startsWith(p));

const missing = [...used.keys()].filter((c) => !ruled.has(c) && !UNRULED.has(c)).sort();
const dead = [...ruled.keys()].filter((c) => !covered(c)).sort();

console.log(`literal classNames: ${used.size}   dynamic prefixes: ${preList.join(", ")}   ruled classes: ${ruled.size}`);
console.log(`\nMISSING RULE (${missing.length}):`);
for (const c of missing) console.log(`  .${c}  <- ${used.get(c).join(", ")}`);
console.log(`\nDEAD RULE (${dead.length}):`);
for (const c of dead) console.log(`  .${c}  <- ${ruled.get(c).join(" | ")}`);
console.log(`\nUnaudited by prefix expansion: ${preList.map((p) => p + "*").join(", ")} -- see the note at the top of this file.`);
console.log(`Deliberately unruled: ${[...UNRULED.keys()].map((c) => "." + c).join(", ") || "none"} -- each is excused at the top of this file.`);
process.exitCode = missing.length + dead.length === 0 ? 0 : 1;