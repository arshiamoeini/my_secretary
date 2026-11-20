#!/usr/bin/env node
// Builds the evidence tables for report.md from one or more results files.
//   node analyze.mjs results/final-*.json
import fs from "node:fs";

const files = process.argv.slice(2).filter((f) => !f.startsWith("--"));
if (!files.length) {
  console.error("usage: node analyze.mjs <results.json> [...]");
  process.exit(1);
}

const rows = [];
for (const f of files) rows.push(...JSON.parse(fs.readFileSync(f, "utf8")).results);

const ONBOARD = /what would you like to call me|what should i call (you|myself)|call me\b.*\?|your name\b.*\?/i;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");

const tools = [...new Set(rows.map((r) => r.tool))];
const cats = [...new Set(rows.map((r) => r.category))];
const tasks = [...new Set(rows.map((r) => r.task))];
const out = [];
const w = (s = "") => out.push(s);

w("# Benchmark analysis");
w();
w(`Runs: ${rows.length} | tools: ${tools.join(", ")} | tasks: ${tasks.length} | generated ${new Date().toISOString()}`);
w();

w("## Overall");
w();
w("| Tool | Runs | Pass | Rate | Median s | Mean s | Mean steps | Total USD | Mean USD | Task questions | Onboarding asks | Errors | Agreement |");
w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const t of tools) {
  const l = rows.filter((r) => r.tool === t);
  const pass = l.filter((r) => r.pass).length;
  const ms = l.map((r) => r.durationMs).filter((x) => x > 0);
  const steps = l.map((r) => r.steps).filter((x) => x != null);
  const cost = l.reduce((a, r) => a + (r.costUsd || 0), 0);
  const taskQ = l.filter((r) => r.askedQuestion && !ONBOARD.test(r.finalText || "")).length;
  const onb = l.filter((r) => ONBOARD.test(r.finalText || "")).length;
  let agree = 0, agreeN = 0;
  for (const id of tasks) {
    const reps = l.filter((r) => r.task === id);
    if (reps.length < 2) continue;
    agreeN++;
    const p = reps.filter((r) => r.pass).length;
    if (p === 0 || p === reps.length) agree++;
  }
  w(
    `| ${t} | ${l.length} | ${pass} | ${pct(pass, l.length)} | ${median(ms) === null ? "-" : (median(ms) / 1000).toFixed(1)} | ` +
    `${ms.length ? (ms.reduce((a, b) => a + b, 0) / ms.length / 1000).toFixed(1) : "-"} | ` +
    `${steps.length ? (steps.reduce((a, b) => a + b, 0) / steps.length).toFixed(1) : "-"} | ` +
    `${cost.toFixed(4)} | ${(cost / l.length).toFixed(4)} | ${taskQ} | ${onb} | ${l.filter((r) => r.error).length} | ` +
    `${agreeN ? pct(agree, agreeN) : "-"} |`
  );
}
w();

w("## By category");
w();
w(`| Category | ${tools.join(" | ")} |`);
w(`| --- | ${tools.map(() => "---").join(" | ")} |`);
for (const c of cats) {
  const cells = tools.map((t) => {
    const l = rows.filter((r) => r.tool === t && r.category === c);
    return l.length ? `${l.filter((r) => r.pass).length}/${l.length} (${pct(l.filter((r) => r.pass).length, l.length)})` : "-";
  });
  w(`| ${c} | ${cells.join(" | ")} |`);
}
w();

w("## Per-task stability (passes / attempts per rep)");
w();
w(`| Task | Cat | ${tools.join(" | ")} |`);
w(`| --- | --- | ${tools.map(() => "---").join(" | ")} |`);
for (const id of tasks) {
  const cat = rows.find((r) => r.task === id)?.category ?? "";
  const cells = tools.map((t) => {
    const reps = rows.filter((r) => r.tool === t && r.task === id).sort((a, b) => a.rep - b.rep);
    if (!reps.length) return "-";
    return reps.map((r) => (r.pass ? "P" : "F")).join("");
  });
  w(`| ${id} | ${cat} | ${cells.join(" | ")} |`);
}
w();

w("## Failures");
w();
const fails = rows.filter((r) => !r.pass);
if (!fails.length) w("None.");
for (const r of fails) {
  const failed = (r.checks || []).filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join("; ");
  w(`- **${r.tool} / ${r.task} rep${r.rep}** — ${r.checkDetail || failed || r.error || "no detail"}`);
}
w();

w("## Token mix (sum over runs)");
w();
w("| Tool | Input (uncached) | Cache read | Output |");
w("| --- | --- | --- | --- |");
for (const t of tools) {
  const l = rows.filter((r) => r.tool === t && r.usage);
  const s = (k) => l.reduce((a, r) => a + (r.usage[k] || 0), 0);
  w(`| ${t} | ${s("input").toLocaleString("en-US")} | ${s("cacheRead").toLocaleString("en-US")} | ${s("output").toLocaleString("en-US")} |`);
}
w();

const text = out.join("\n");
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/analysis.md", text + "\n");
console.log(text);
