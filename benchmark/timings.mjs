import fs from "node:fs";

// Per-answer timing for the interactive Phone Q&A calls.
// Reads the graded rows in results/final1-all.json (the source of truth) and
// writes results/phone-timings.md. No model spend, no sandbox access.
//
//   node timings.mjs

const db = JSON.parse(fs.readFileSync("results/final1-all.json", "utf8"));
const rows = db.results.filter((r) => r.task.startsWith("D"));
const tools = ["vanilla", "openagent", "cowagent", "openclaw"];
const s = (ms) => (ms / 1000).toFixed(1);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

if (rows.length !== 20) throw new Error(`expected 20 Phone Q&A rows, got ${rows.length}`);
for (const r of rows) {
  if (!r.turnTimings || r.turnTimings.length !== 3) throw new Error(`${r.tool}/${r.task}: missing turn timings`);
  if (r.postMs == null) throw new Error(`${r.tool}/${r.task}: missing postMs`);
}

const out = [];
const w = (x = "") => out.push(x);

w("# Phone Q&A - per-answer timing (interactive calls)");
w();
w("Source: the 20 Phone Q&A rows in `results/final1-all.json` (5 tasks x 4 tools),");
w("regenerate with `node timings.mjs`. Each task is a scripted three-turn phone");
w("call followed by one post-call file-writing turn. `setup` (process/server");
w("startup) is reported separately from the caller turns. All values are seconds.");
w();
w("Turns: **T0** = greeting (\"Hello?\"), **T1** = caller states the request,");
w("**T2** = caller confirms / asks a follow-up, **post** = write the report after");
w("the call. **Answers** = T0+T1+T2, i.e. what the caller actually waits through.");
w();
w("For OpenClaw there is no server: its first CLI invocation includes process");
w("start, agent bootstrap *and* the opening greeting, so its `setup` is a subset");
w("of T0, marked `*` below. `Total` = setup + answers + post for the other three;");
w("for OpenClaw it is T0+T1+T2+post (setup already inside T0).");
w();

w("## Per-tool summary (mean over the five calls)");
w();
w("| Tool | Setup | T0 greeting | T1 request | T2 follow-up | Answers | Post-call file | Total wall |");
w("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const t of tools) {
  const rs = rows.filter((r) => r.tool === t);
  const t0 = mean(rs.map((r) => r.turnTimings[0].ms));
  const t1 = mean(rs.map((r) => r.turnTimings[1].ms));
  const t2 = mean(rs.map((r) => r.turnTimings[2].ms));
  const post = mean(rs.map((r) => r.postMs));
  const setup = mean(rs.map((r) => r.setupMs || 0));
  const total = mean(rs.map((r) => r.durationMs));
  const mark = t === "openclaw" ? "*" : "";
  w(`| ${t} | ${s(setup)}${mark} | ${s(t0)} | ${s(t1)} | ${s(t2)} | ${s(t0 + t1 + t2)} | ${s(post)} | ${s(total)} |`);
}
w();
w("Notes:");
w();
w("- Vanilla runs in-process, so `setup` is 0 by construction.");
w("- OpenAgent/CowAgent `setup` is the time until the local HTTP port accepts");
w("  connections; the first model call happens inside T0.");
w("- OpenClaw `*`: the 73 s setup is the whole first invocation, greeting included;");
w("  adding setup to the answers would count it twice.");
w("- The caller speaks between turns, so `Total` also contains a few seconds of");
w("  caller audio; the rows measure tool wall time only.");
w();

w("## Every answer, call by call");
w();
w("| Tool | Task | Setup | T0 | T1 | T2 | Answers | Post | Total |");
w("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const t of tools) {
  for (const r of rows.filter((x) => x.tool === t).sort((a, b) => a.task.localeCompare(b.task))) {
    const [a, b, c] = r.turnTimings.map((x) => x.ms);
    const mark = t === "openclaw" ? "*" : "";
    w(`| ${t} | ${r.task} | ${s(r.setupMs || 0)}${mark} | ${s(a)} | ${s(b)} | ${s(c)} | ${s(a + b + c)} | ${s(r.postMs)} | ${s(r.durationMs)} |`);
  }
}
w();

w("## Raw per-turn milliseconds");
w();
w("| Tool | Task | setupMs | T0 ms | T1 ms | T2 ms | postMs | durationMs |");
w("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const t of tools) {
  for (const r of rows.filter((x) => x.tool === t).sort((a, b) => a.task.localeCompare(b.task))) {
    const [a, b, c] = r.turnTimings.map((x) => x.ms);
    w(`| ${t} | ${r.task} | ${r.setupMs ?? 0} | ${a} | ${b} | ${c} | ${r.postMs} | ${r.durationMs} |`);
  }
}
w();

w("## What the caller hears (privacy task D2, all four tools)");
w();
w("Full transcripts for every call are in `runs/<tool>/<task>/r1/meta/conversation.json`.");
w();
for (const r of rows.filter((x) => x.task.startsWith("D2")).sort((a, b) => tools.indexOf(a.tool) - tools.indexOf(b.tool))) {
  w(`- **${r.tool}**`);
  for (const [i, turn] of r.turnTimings.entries()) w(`  - T${i} (${s(turn.ms)} s): ${JSON.stringify(turn.reply)}`);
  w(`  - post-call write: ${s(r.postMs)} s`);
}
w();

fs.writeFileSync("results/phone-timings.md", out.join("\n") + "\n");
console.log("wrote results/phone-timings.md");
