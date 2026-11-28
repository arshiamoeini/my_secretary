#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { costOf, MODEL } from "./lib/pricing.mjs";
import { admin } from "./tasks/admin.mjs";
import { scheduling } from "./tasks/scheduling.mjs";
import { retrieval } from "./tasks/retrieval.mjs";
import { phone } from "./tasks/phone.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHOOL = path.join(HERE, "school");
const RUNS = path.join(HERE, "runs");
const RESULTS = path.join(HERE, "results");

export const ALL_TASKS = [...admin, ...scheduling, ...retrieval, ...phone];

const ADAPTERS = {
  openclaw: () => import("./adapters/openclaw.mjs"),
  vanilla: () => import("./adapters/vanilla.mjs"),
  cowagent: () => import("./adapters/cowagent.mjs"),
  openagent: () => import("./adapters/openagent.mjs"),
};

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const hit = a.find((x) => x.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  return {
    tools: get("tools", "openclaw,vanilla").split(",").filter(Boolean),
    tasks: get("tasks", "all"),
    reps: Number(get("reps", "1")),
    concurrency: Number(get("concurrency", "2")),
    timeout: Number(get("timeout", "420000")),
    label: get("label", "run"),
    out: get("out", ""),
    resume: a.includes("--resume"),
    checkpoint: get("checkpoint", ""),
  };
}

const ts = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

function freshDir(p) {
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
}

async function main() {
  const opt = args();
  const taskIds = opt.tasks === "all" ? null : new Set(opt.tasks.split(","));
  const tasks = ALL_TASKS.filter((t) => !taskIds || taskIds.has(t.id));
  const jobs = [];
  for (const tool of opt.tools) for (const t of tasks) for (let r = 1; r <= opt.reps; r++) jobs.push({ tool, task: t, rep: r });

  fs.mkdirSync(RESULTS, { recursive: true });
  const file = opt.out || path.join(RESULTS, `${opt.label}-${ts()}.json`);
  const ckpt = opt.checkpoint || path.join(RESULTS, `.checkpoint-${opt.label}.json`);
  const meta = {
    label: opt.label,
    model: MODEL,
    startedAt: new Date().toISOString(),
    tools: opt.tools,
    reps: opt.reps,
    taskCount: tasks.length,
    timeoutMs: opt.timeout,
    host: process.platform,
  };

  // Resume: a run is identified by tool|task|rep. Finished runs are kept, so a
  // killed/failed-resource run (credit exhaustion, timeout) can continue where
  // it stopped without paying for the finished ones again.
  const key = (r) => `${r.tool}|${r.task}|${r.rep}`;
  const jobKey = (j) => `${j.tool}|${j.task.id}|${j.rep}`;
  let prior = [];
  let extra = [];
  if (opt.resume) {
    for (const f of [ckpt, file]) {
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        const all = j.results || [];
        const rows = all.filter((r) => jobs.some((x) => jobKey(x) === key(r)));
        if (rows.length > prior.length) {
          prior = rows;
          // Keep out-of-scope rows in the checkpoint so a partial re-run does
          // not shrink it; they are not written to this run's output file.
          extra = all.filter((r) => !jobs.some((x) => jobKey(x) === key(r)));
          console.log(`[bench] resuming from ${f}: ${prior.length} finished run(s)`);
        }
      } catch (e) {
        console.log(`[bench] cannot read ${f}: ${e.message}`);
      }
    }
  }
  const have = new Set(prior.map(key));
  const pending = jobs.filter((j) => !have.has(jobKey(j)));

  console.log(`[bench] ${jobs.length} runs: ${opt.tools.join(",")} x ${tasks.length} tasks x ${opt.reps} rep(s), concurrency ${opt.concurrency}`);
  console.log(`[bench] ${prior.length} already done, ${pending.length} pending; checkpoint ${ckpt}`);

  const collected = [];
  const save = () => {
    const payload = { meta, results: [...extra, ...prior, ...collected] };
    const tmp = ckpt + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, ckpt);
  };
  save();

  let done = prior.length;
  const results = [...prior, ...(await pool(pending, opt.concurrency, async (job) => {
    const adapter = await ADAPTERS[job.tool]();
    const base = path.join(RUNS, job.tool, job.task.id, `r${job.rep}`);
    const sandbox = path.join(base, "work");
    const runDir = path.join(base, "meta");
    freshDir(sandbox);
    freshDir(runDir);
    fs.cpSync(SCHOOL, sandbox, { recursive: true });

    let res;
    try {
      if (Array.isArray(job.task.conversation) && typeof adapter.converse === "function") {
        res = await adapter.converse({
          sandbox,
          prompt: job.task.prompt,
          conversation: job.task.conversation,
          post: job.task.post,
          runDir,
          timeoutMs: opt.timeout,
        });
      } else {
        res = await adapter.run({ sandbox, prompt: job.task.prompt, runDir, timeoutMs: opt.timeout });
      }
    } catch (e) {
      res = { ok: false, exitCode: -1, durationMs: 0, usage: null, steps: null, text: "", humanEvents: [], error: String(e?.stack || e), raw: {} };
    }
    // A billing failure is not a task failure: abort the phase before recording
    // it, so the checkpoint keeps only real runs and `--resume` can finish later.
    if (/insufficient credit|exceeded your current quota/i.test(res.error || "")) {
      throw new Error("CREDIT_EXHAUSTED: " + res.error);
    }

    let check;
    try {
      check = job.task.validate(sandbox);
    } catch (e) {
      check = { pass: false, detail: "validator error: " + e.message, checks: [] };
    }

    const asked = /(\?|please confirm|let me know|would you like)\s*$/i.test((res.text || "").trim());
    const rec = {
      tool: job.tool,
      toolName: adapter.meta.name,
      task: job.task.id,
      category: job.task.category,
      title: job.task.title,
      rep: job.rep,
      pass: check.pass,
      checkDetail: check.detail,
      checks: check.checks,
      ok: res.ok,
      exitCode: res.exitCode,
      error: res.error || null,
      durationMs: res.durationMs,
      steps: res.steps,
      toolFailures: res.toolFailures ?? null,
      usage: res.usage,
      costUsd: costOf(res.usage),
      askedQuestion: asked,
      humanEvents: res.humanEvents || [],
      setupMs: res.setupMs ?? null,
      setupNote: res.setupNote ?? null,
      turnTimings: res.turnTimings ?? null,
      postMs: res.postMs ?? null,
      postReply: res.postReply ?? null,
      finalText: (res.text || "").slice(0, 4000),
      sandbox,
      finishedAt: new Date().toISOString(),
    };
    done++;
    const timing = Array.isArray(rec.turnTimings) && rec.turnTimings.length
      ? ` turns=[${rec.turnTimings.map((t) => (t.ms / 1000).toFixed(1)).join(", ")}]` +
        ` setup=${((rec.setupMs || 0) / 1000).toFixed(1)}s` +
        ` post=${rec.postMs == null ? "-" : (rec.postMs / 1000).toFixed(1) + "s"}`
      : "";
    console.log(
      `[${done}/${jobs.length}] ${job.tool.padEnd(8)} ${job.task.id.padEnd(30)} rep${job.rep} ` +
      `${check.pass ? "PASS" : "FAIL"} ${(res.durationMs / 1000).toFixed(1)}s ` +
      `${rec.steps ?? "?"} steps $${rec.costUsd.toFixed(4)}${timing}${check.pass ? "" : "  <- " + check.detail.slice(0, 160)}`
    );
    collected.push(rec);
    save();
    return rec;
  }))];

  fs.writeFileSync(file, JSON.stringify({ meta, results }, null, 2));
  fs.writeFileSync(path.join(RESULTS, "latest.json"), JSON.stringify({ meta, results }, null, 2));

  // quick scoreboard
  const agg = {};
  for (const r of results) {
    agg[r.tool] ??= { pass: 0, n: 0, ms: 0, cost: 0, steps: 0, stepsN: 0, asked: 0 };
    const a = agg[r.tool];
    a.n++; a.pass += r.pass ? 1 : 0; a.ms += r.durationMs; a.cost += r.costUsd; a.asked += r.askedQuestion ? 1 : 0;
    if (r.steps != null) { a.steps += r.steps; a.stepsN++; }
  }
  console.log("\nTOOL          PASS   RATE   AVG_S   COST_USD  AVG_STEPS  ASKED_Q");
  for (const [t, a] of Object.entries(agg)) {
    console.log(
      t.padEnd(13) + `${a.pass}/${a.n}`.padEnd(7) + `${((a.pass / a.n) * 100).toFixed(0)}%`.padEnd(7) +
      `${(a.ms / a.n / 1000).toFixed(1)}`.padEnd(8) + `${a.cost.toFixed(4)}`.padEnd(10) +
      `${a.stepsN ? (a.steps / a.stepsN).toFixed(1) : "-"}`.padEnd(11) + `${a.asked}`
    );
  }
  console.log(`\n[bench] wrote ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("benchmark/run.mjs")) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(/insufficient credit|CREDIT_EXHAUSTED/i.test(String(e?.message || e)) ? 3 : 1);
  });
}
