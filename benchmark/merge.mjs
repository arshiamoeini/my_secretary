#!/usr/bin/env node
// Merge results files, optionally replacing specific tasks with newer runs.
//   node merge.mjs --out=final.json --replace=D2-unverified-caller \
//        results/final-openclaw.json --patch=results/d2-rerun.json
// `--replace` tasks are dropped from every base file; patch files are appended
// whole (so their replacement rows survive).
import fs from "node:fs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const out = opt("out");
if (!out) {
  console.error("usage: node merge.mjs --out=<file> [--replace=<taskId>]... <base.json> ... --patch=<file> ...");
  process.exit(1);
}
const replace = argv.filter((a) => a.startsWith("--replace=")).map((a) => a.slice("--replace=".length));
const bases = argv.filter((a) => !a.startsWith("--"));
const patches = argv.filter((a) => a.startsWith("--patch=")).map((a) => a.slice("--patch=".length));

const rows = [];
const metas = [];
for (const f of bases) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  metas.push(j.meta);
  rows.push(...j.results.filter((r) => !replace.includes(r.task)));
}
for (const f of patches) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  metas.push(j.meta);
  rows.push(...j.results);
}
fs.writeFileSync(out, JSON.stringify({ meta: { merged: metas, replaced: replace, at: new Date().toISOString() }, results: rows }, null, 2));
console.log(`wrote ${out}: ${rows.length} runs, replaced ${replace.join(", ") || "nothing"}`);
