#!/usr/bin/env node
// Composite ranking from one or more results files.
//
// Weights are explicit and deliberately favour the things a school office
// actually cares about: doing the task right, doing it the same way every
// time, and not handing work back to a human. Speed and price break ties.
//
//   success        0.55   validator pass rate
//   reliability    0.15   fraction of tasks whose repeats all agree
//   autonomy       0.15   1 - (failed runs that ended by asking the user)
//   speed          0.10   fastest median wall-clock / this tool's median
//   cost           0.05   cheapest mean cost / this tool's mean cost
import fs from "node:fs";

const files = process.argv.slice(2).filter((f) => !f.startsWith("--"));
if (!files.length) {
  console.error("usage: node rank.mjs <results.json> [...]");
  process.exit(1);
}

const rows = [];
for (const f of files) rows.push(...JSON.parse(fs.readFileSync(f, "utf8")).results);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const ONBOARD = /what would you like to call me|what should i call (you|myself)|call me\b.*\?|your name\b.*\?/i;

const tools = [...new Set(rows.map((r) => r.tool))];
const stats = tools.map((tool) => {
  const list = rows.filter((r) => r.tool === tool);
  const taskIds = [...new Set(list.map((r) => r.task))];
  const pass = list.filter((r) => r.pass).length;
  let agree = 0, agreeN = 0;
  for (const id of taskIds) {
    const reps = list.filter((r) => r.task === id);
    if (reps.length < 2) continue;
    agreeN++;
    const p = reps.filter((r) => r.pass).length;
    if (p === 0 || p === reps.length) agree++;
  }
  const failedAsked = list.filter((r) => !r.pass && r.askedQuestion && !ONBOARD.test(r.finalText || "")).length;
  return {
    tool,
    n: list.length,
    reps: Math.max(...taskIds.map((id) => list.filter((r) => r.task === id).length)),
    passRate: list.length ? pass / list.length : 0,
    agreement: agreeN ? agree / agreeN : null,
    autonomy: list.length ? 1 - failedAsked / list.length : 0,
    medianSec: median(list.map((r) => r.durationMs).filter((x) => x > 0)) / 1000,
    meanUsd: list.reduce((a, r) => a + (r.costUsd || 0), 0) / (list.length || 1),
    errors: list.filter((r) => r.error).length,
  };
});

const bestSec = Math.min(...stats.map((s) => s.medianSec));
const bestUsd = Math.min(...stats.map((s) => s.meanUsd));
const singleRep = stats.every((s) => s.agreement === null);

for (const s of stats) {
  s.speed = bestSec / s.medianSec;
  s.cost = bestUsd / Math.max(s.meanUsd, 1e-9);
  // With one rep per task, repeat agreement cannot be measured; fold its 0.15
  // into success rather than silently double-counting success under its name.
  const aw = s.agreement === null ? 0 : 0.15;
  s.score =
    (0.55 + (0.15 - aw)) * s.passRate +
    aw * s.agreement +
    0.15 * s.autonomy +
    0.10 * s.speed +
    0.05 * s.cost;
}

stats.sort((a, b) => b.score - a.score);

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const lines = [];
if (singleRep) {
  lines.push("_One run per task: repeat agreement is not measurable, so its 0.15 weight is folded into success (success 0.70, autonomy 0.15, speed 0.10, cost 0.05)._");
  lines.push("");
}
lines.push("| Rank | Tool | Score | Success | Reps | Agreement | Autonomy | Median s | Mean USD | Errors |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
stats.forEach((s, i) => {
  lines.push(
    `| ${i + 1} | ${s.tool} | ${s.score.toFixed(3)} | ${pct(s.passRate)} (${Math.round(s.passRate * s.n)}/${s.n}) | ${s.reps} | ` +
    `${s.agreement === null ? "-" : pct(s.agreement)} | ${pct(s.autonomy)} | ${s.medianSec.toFixed(1)} | ${s.meanUsd.toFixed(4)} | ${s.errors} |`
  );
});
console.log(lines.join("\n"));

const out = "results/ranking.md";
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`\nwrote ${out}`);
