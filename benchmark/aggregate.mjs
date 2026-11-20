#!/usr/bin/env node
// Aggregates one or more results files into a comparison table.
// Usage: node aggregate.mjs results/pilot-full-*.json [more.json ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const files = process.argv.slice(2).filter((f) => !f.startsWith("--"));
if (!files.length) {
  console.error("usage: node aggregate.mjs <results.json> [...]");
  process.exit(1);
}

const rows = [];
const metas = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  metas.push(j.meta);
  rows.push(...j.results);
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : "-");
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function agg(list) {
  const n = list.length;
  const pass = list.filter((r) => r.pass).length;
  const ms = list.map((r) => r.durationMs).filter((x) => x > 0);
  const costs = list.map((r) => r.costUsd || 0);
  const steps = list.map((r) => r.steps).filter((x) => x != null);
  const asked = list.filter((r) => r.askedQuestion).length;
  const onboarding = list.filter((r) => isOnboardingQuestion(r.finalText)).length;
  const taskQuestion = list.filter((r) => r.askedQuestion && !isOnboardingQuestion(r.finalText)).length;
  const needsHuman = list.filter((r) => !r.pass && r.askedQuestion && !isOnboardingQuestion(r.finalText)).length;
  const human = list.filter((r) => (r.humanEvents || []).length).length;
  const errors = list.filter((r) => r.error).length;
  return {
    n, pass, rate: n ? pass / n : 0,
    meanSec: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length / 1000 : null,
    medianSec: median(ms) !== null ? median(ms) / 1000 : null,
    totalUsd: costs.reduce((a, b) => a + b, 0),
    meanUsd: n ? costs.reduce((a, b) => a + b, 0) / n : 0,
    meanSteps: steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : null,
    stepsMeasured: steps.length,
    asked, onboarding, taskQuestion, needsHuman, human, errors,
  };
}

// A first-run persona prompt ("what should I call myself?") is scaffolding
// noise, not a task-level question to the user.
function isOnboardingQuestion(text) {
  const t = String(text || "");
  return /what would you like to call me|what should i call (you|myself)|call me\b.*\?|your name\b.*\?/i.test(t);
}

const tools = [...new Set(rows.map((r) => r.tool))];
const byTool = Object.fromEntries(tools.map((t) => [t, agg(rows.filter((r) => r.tool === t))]));

const taskIds = [...new Set(rows.map((r) => r.task))];
const categories = [...new Set(rows.map((r) => r.category))];

// Consistency: for each tool+task, did every repeat agree?
function consistency(tool) {
  let consistent = 0; let total = 0;
  for (const id of taskIds) {
    const reps = rows.filter((r) => r.tool === tool && r.task === id);
    if (reps.length < 2) continue;
    total++;
    const p = reps.filter((r) => r.pass).length;
    if (p === 0 || p === reps.length) consistent++;
  }
  return total ? consistent / total : null;
}

const esc = (s) => String(s).replace(/\|/g, "\\|");

const lines = [];
lines.push("# Benchmark summary");
lines.push("");
lines.push(`Generated ${new Date().toISOString()}`);
lines.push("");
lines.push("## Overall");
lines.push("");
lines.push("| Tool | Runs | Pass | Rate | Median s | Mean s | Mean steps | Cost (USD) | Mean cost | Task questions | Onboarding questions | Failed-and-asked | Errors | Repeat agreement |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const t of tools) {
  const a = byTool[t];
  const c = consistency(t);
  lines.push(
    `| ${esc(t)} | ${a.n} | ${a.pass} | ${pct(a.pass, a.n)} | ${a.medianSec?.toFixed(1) ?? "-"} | ${a.meanSec?.toFixed(1) ?? "-"} | ` +
    `${a.meanSteps?.toFixed(1) ?? "-"} | ${a.totalUsd.toFixed(4)} | ${a.meanUsd.toFixed(4)} | ${a.taskQuestion} | ${a.onboarding} | ${a.needsHuman} | ${a.errors} | ${c === null ? "-" : pct(c, 1)} |`
  );
}
lines.push("");
lines.push("## By category");
lines.push("");
for (const cat of categories) {
  lines.push(`### ${cat}`);
  lines.push("");
  lines.push("| Tool | Pass | Rate | Median s | Cost (USD) |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tools) {
    const a = agg(rows.filter((r) => r.tool === t && r.category === cat));
    if (!a.n) continue;
    lines.push(`| ${esc(t)} | ${a.pass}/${a.n} | ${pct(a.pass, a.n)} | ${a.medianSec?.toFixed(1) ?? "-"} | ${a.totalUsd.toFixed(4)} |`);
  }
  lines.push("");
}
lines.push("## Per task");
lines.push("");
lines.push(`| Task | ${tools.map(esc).join(" | ")} |`);
lines.push(`| --- | ${tools.map(() => "---").join(" | ")} |`);
for (const id of taskIds) {
  const cells = tools.map((t) => {
    const reps = rows.filter((r) => r.tool === t && r.task === id);
    if (!reps.length) return "·";
    const p = reps.filter((r) => r.pass).length;
    return `${p}/${reps.length}`;
  });
  lines.push(`| ${esc(id)} | ${cells.join(" | ")} |`);
}
lines.push("");
lines.push("## Failures");
lines.push("");
const fails = rows.filter((r) => !r.pass);
if (!fails.length) lines.push("None.");
else {
  lines.push("| Tool | Task | Rep | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of fails) lines.push(`| ${esc(r.tool)} | ${esc(r.task)} | ${r.rep} | ${esc((r.checkDetail || "").slice(0, 220))} |`);
}
lines.push("");
lines.push("## Run metadata");
lines.push("");
for (const m of metas) lines.push(`- ${m.label}: model=${m.model}, tools=${(m.tools || []).join(",")}, reps=${m.reps}, tasks=${m.taskCount}, host=${m.host}`);
lines.push("");

const out = path.join(HERE, "results", "summary.md");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join("\n"));
fs.writeFileSync(path.join(HERE, "results", "summary.json"), JSON.stringify({ byTool, rows }, null, 2));
console.log(lines.join("\n"));
console.log(`\nwrote ${out}`);
