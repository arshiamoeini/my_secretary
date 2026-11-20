#!/usr/bin/env node
// Assemble the one-run-per-tool dataset from the runs that already exist.
//
//   openclaw : rep 1 of results/final-openclaw-*.json (3 reps were run)
//   vanilla  : results/pilot-vanilla.json (revalidated pilot, 1 rep)
//   openagent: results/final1-openagent-*.json
//   cowagent : results/final1-cowagent-*.json
//   D2       : results/d2-all-*.json (new prompt) overlays the D2 row for the
//              tools it contains (openclaw, vanilla); the other tools' D2 rows
//              come from their own one-rep runs.
import fs from "node:fs";
import path from "node:path";

const RESULTS = "results";
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const pick = (pat) => {
  const hits = fs.readdirSync(RESULTS).filter((f) => f.startsWith(pat) && f.endsWith(".json"));
  if (!hits.length) return null;
  hits.sort();
  return read(path.join(RESULTS, hits[hits.length - 1]));
};

const sources = {
  openclaw: () => (pick("final-openclaw-")?.results || []).filter((r) => r.rep === 1),
  vanilla: () => pick("pilot-vanilla")?.results || [],
  openagent: () => pick("final1-openagent-")?.results || [],
  cowagent: () => pick("final1-cowagent-")?.results || [],
};
const d2 = pick("d2-all-")?.results || [];

const TASKS = ["A1-attendance-summary", "A2-fieldtrip-permissions", "A3-purchase-order", "A4-file-organization",
  "B1-find-meeting-slot", "B2-room-conflicts", "B3-duty-roster", "B4-confirmation-email",
  "C1-allergy-list", "C2-medication-policy", "C3-bus-route", "C4-overdue-library",
  "D1-early-release-call", "D2-unverified-caller", "D3-lunch-menu-call", "D4-log-absence", "D5-inbox-summary-injection"];

const map = new Map();
const keyOf = (r) => `${r.tool}|${r.task}`;
for (const [tool, load] of Object.entries(sources)) {
  const list = load();
  if (!list.length) console.error(`WARNING: no rows for ${tool}`);
  for (const r of list) map.set(keyOf(r), r);
}
// New-prompt D2 runs win over whatever the base files carry.
for (const r of d2) map.set(keyOf(r), r);

const final = [...map.values()];
const tools = [...new Set(final.map((r) => r.tool))].sort();
const missing = [];
for (const t of tools) for (const id of TASKS) if (!map.has(`${t}|${id}`)) missing.push(`${t} ${id}`);

console.log("tool        rows  pass  rate");
for (const t of tools) {
  const l = final.filter((r) => r.tool === t);
  const p = l.filter((r) => r.pass).length;
  console.log(`${t.padEnd(11)} ${String(l.length).padEnd(5)} ${String(p).padEnd(5)} ${Math.round((p / l.length) * 100)}%`);
}
if (missing.length) {
  console.error(`\nMISSING ${missing.length} run(s):\n  ${missing.join("\n  ")}`);
  process.exitCode = 1;
}

const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6) || path.join(RESULTS, "final1-all.json");
fs.writeFileSync(out, JSON.stringify({
  meta: {
    label: "final1-all",
    design: "one run per tool per task; D2 re-run under the final prompt",
    assembledAt: new Date().toISOString(),
    tools,
  },
  results: final,
}, null, 2));
console.log(`\nwrote ${out}: ${final.length} runs${missing.length ? " (INCOMPLETE)" : ""}`);
