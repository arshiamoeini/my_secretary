#!/usr/bin/env node
// Recompute costUsd for every row in a results file from its token usage and the
// current price table. No model calls, so it is free and repeatable.
//   node reprice.mjs results/final1-all.json [more.json ...]
import fs from "node:fs";
import { PRICE, costOf } from "./lib/pricing.mjs";

const files = process.argv.slice(2).filter((f) => !f.startsWith("--"));
const write = process.argv.includes("--write");
if (!files.length) {
  console.error("usage: node reprice.mjs <results.json> [...] [--write]");
  process.exit(1);
}

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  let changed = 0;
  let total = 0;
  for (const r of j.results) {
    const next = costOf(r.usage);
    if (Math.abs(next - (r.costUsd || 0)) > 1e-9) changed++;
    r.costUsd = next;
    total += next;
  }
  console.log(`${f}: ${j.results.length} rows, ${changed} recosted, total $${total.toFixed(4)}`);
  if (write) {
    j.meta = { ...(j.meta || {}), repricedAt: new Date().toISOString(), price: PRICE };
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  }
}
console.log(write ? "\nwritten." : "\nadd --write to save.");
