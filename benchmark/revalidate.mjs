#!/usr/bin/env node
// Re-runs the current validators against the sandboxes recorded in a results
// file. Useful after a validator change without paying for new model runs.
import fs from "node:fs";
import { ALL_TASKS } from "./run.mjs";

const file = process.argv[2];
const write = process.argv.includes("--write");
if (!file) {
  console.error("usage: node revalidate.mjs <results.json> [--write]");
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(file, "utf8"));
const byId = Object.fromEntries(ALL_TASKS.map((t) => [t.id, t]));
let changed = 0;
for (const r of j.results) {
  const task = byId[r.task];
  if (!task) {
    console.log(`? ${r.tool} ${r.task}: unknown task`);
    continue;
  }
  let check;
  try {
    check = task.validate(r.sandbox);
  } catch (e) {
    check = { pass: false, detail: "validator error: " + e.message };
  }
  const before = r.pass;
  const diff = check.pass !== before ? "  <-- CHANGED" : "";
  if (diff) changed++;
  r.pass = check.pass;
  r.checkDetail = check.detail;
  r.checks = check.checks;
  console.log(`${r.tool.padEnd(10)} ${r.task.padEnd(28)} was=${before ? "PASS" : "FAIL"} now=${check.pass ? "PASS" : "FAIL"}${diff}  ${check.pass ? "" : check.detail}`);
}
if (write) {
  j.meta = { ...(j.meta || {}), revalidatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  console.log(`\n${changed} result(s) changed; wrote ${file}`);
} else {
  console.log(`\n${changed} result(s) changed. Add --write to save them.`);
}
