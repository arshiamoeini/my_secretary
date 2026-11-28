import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstCallerMessage, emptyUsage, addUsage, usageDelta } from "../lib/conversation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NPX_BIN = process.env.OPENCLAW_BIN || "openclaw";
export const HOME = process.env.USERPROFILE || os.homedir();

const BASE_CONFIG = path.join(HOME, ".openclaw", "openclaw.json");

export const meta = {
  id: "openclaw",
  name: "OpenClaw 2026.11.5",
  kind: "assistant",
  notes: "Gateway-class personal assistant, headless embedded agent (--local), tools profile=full",
};

function prepare(sandbox, runDir) {
  const cfg = JSON.parse(fs.readFileSync(BASE_CONFIG, "utf8"));
  cfg.agents.defaults.workspace = sandbox;
  cfg.agents.entries.secretary.workspace = sandbox;
  cfg.agents.entries.secretary.agentDir = path.join(runDir, "agent");
  fs.mkdirSync(path.join(runDir, "state"), { recursive: true });
  const cfgPath = path.join(runDir, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

export async function run({ sandbox, prompt, runDir, timeoutMs = 300000 }) {
  const cfgPath = prepare(sandbox, runDir);
  const promptFile = path.join(runDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf8");

  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: cfgPath,
    OPENCLAW_STATE_DIR: path.join(runDir, "state"),
    NO_COLOR: "1",
  };
  delete env.OPENCLAW_PROFILE;

  const args = [
    "agent", "--local", "--agent", "secretary",
    "--message-file", promptFile,
    "--json",
    "--timeout", String(Math.round(timeoutMs / 1000)),
  ];

  const started = Date.now();
  const res = await execCmd(NPX_BIN === "openclaw" ? "openclaw.cmd" : NPX_BIN, args, { cwd: sandbox, env, timeoutMs: timeoutMs + 30000 });
  const durationMs = Date.now() - started;

  let parsed = null;
  try {
    const s = res.stdout.indexOf("{");
    const e = res.stdout.lastIndexOf("}");
    if (s >= 0 && e > s) parsed = JSON.parse(res.stdout.slice(s, e + 1));
  } catch { /* ignore */ }

  const m = parsed?.meta || {};
  const usage = m.agentMeta?.usage
    ? {
        input: m.agentMeta.usage.input || 0,
        output: m.agentMeta.usage.output || 0,
        cacheRead: m.agentMeta.usage.cacheRead || 0,
        cacheWrite: m.agentMeta.usage.cacheWrite || 0,
      }
    : null;

  const text = (parsed?.payloads || []).map((p) => p.text || "").join("\n\n").trim();
  const stderr = res.stderr || "";
  const humanEvents = [];
  if (/approval|approve|permission denied/i.test(stderr) && !/denied.*tool.*not found/i.test(stderr)) {
    if (/requires? (approval|confirmation)|waiting for approval/i.test(stderr)) humanEvents.push("approval-blocked");
  }

  return {
    ok: res.code === 0 && !!parsed,
    exitCode: res.code,
    durationMs,
    usage,
    steps: m.toolSummary?.calls ?? null,
    toolFailures: m.toolSummary?.failures ?? null,
    text,
    humanEvents,
    raw: { stdoutTail: res.stdout.slice(-4000), stderrTail: stderr.slice(-2000), timedOut: res.timedOut },
  };
}

/**
 * Interactive phone-call mode. OpenClaw's `agent --local` is a one-shot CLI,
 * so we keep one session key and one state dir across invocations. The first
 * invocation pays process startup + agent bootstrap + the opening greeting, so
 * its whole duration is reported as `setupMs` (marked `includesSetup` in the
 * timing row). Later caller turns and the post-call write are timed separately.
 */
export async function converse({ sandbox, prompt, conversation, post, runDir, timeoutMs = 300000 }) {
  const cfgPath = prepare(sandbox, runDir);
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: cfgPath,
    OPENCLAW_STATE_DIR: path.join(runDir, "state"),
    NO_COLOR: "1",
  };
  delete env.OPENCLAW_PROFILE;

  const started = Date.now();
  const sessionKey = `agent:secretary:bench-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const usage = emptyUsage();
  const turnTimings = [];
  const humanEvents = [];
  let totalSteps = 0;
  let totalFailures = 0;
  let error = null;
  let setupMs = null;

  async function call(message, n, budgetMs) {
    const promptFile = path.join(runDir, `turn-${n}.txt`);
    fs.writeFileSync(promptFile, message, "utf8");
    const args = [
      "agent", "--local", "--agent", "secretary",
      "--message-file", promptFile,
      "--json",
      "--timeout", String(Math.max(30, Math.round(budgetMs / 1000))),
      "--session-key", sessionKey,
    ];
    const before = { ...usage };
    const t0 = Date.now();
    const res = await execCmd(NPX_BIN === "openclaw" ? "openclaw.cmd" : NPX_BIN, args, {
      cwd: sandbox, env, timeoutMs: budgetMs + 30000,
    });
    const ms = Date.now() - t0;

    let parsed = null;
    try {
      const s = res.stdout.indexOf("{");
      const e = res.stdout.lastIndexOf("}");
      if (s >= 0 && e > s) parsed = JSON.parse(res.stdout.slice(s, e + 1));
    } catch { /* ignore */ }

    const m = parsed?.meta || {};
    const u = m.agentMeta?.usage
      ? {
          input: m.agentMeta.usage.input || 0,
          output: m.agentMeta.usage.output || 0,
          cacheRead: m.agentMeta.usage.cacheRead || 0,
          cacheWrite: m.agentMeta.usage.cacheWrite || 0,
        }
      : null;
    addUsage(usage, u);
    totalSteps += m.toolSummary?.calls ?? 0;
    totalFailures += m.toolSummary?.failures ?? 0;

    const stderr = res.stderr || "";
    if (/approval|approve|permission denied/i.test(stderr) && !/denied.*tool.*not found/i.test(stderr)) {
      if (/requires? (approval|confirmation)|waiting for approval/i.test(stderr)) humanEvents.push("approval-blocked");
    }

    const text = (parsed?.payloads || []).map((p) => p.text || "").join("\n\n").trim();
    return {
      ok: res.code === 0 && !!parsed,
      exitCode: res.code,
      ms,
      text,
      usage: u ? usageDelta(before, usage) : null,
      error: res.code === 0 && parsed ? null : `openclaw exit ${res.code}`,
      raw: { stdoutTail: res.stdout.slice(-4000), stderrTail: stderr.slice(-2000), timedOut: res.timedOut },
    };
  }

  const budget = () => Math.max(30000, timeoutMs - (Date.now() - started));

  const first = await call(firstCallerMessage(prompt, conversation[0]), 0, budget());
  setupMs = first.ms;
  turnTimings.push({
    turn: 0,
    caller: conversation[0],
    reply: first.text,
    ms: first.ms,
    usage: first.usage,
    includesSetup: true,
    error: first.error,
    raw: first.raw,
  });
  if (!first.ok) error = first.error;

  for (let i = 1; i < conversation.length && !error; i++) {
    const r = await call(conversation[i], i, budget());
    turnTimings.push({ turn: i, caller: conversation[i], reply: r.text, ms: r.ms, usage: r.usage, error: r.error, raw: r.raw });
    if (!r.ok) error = r.error;
  }

  let postMs = null;
  let postReply = "";
  if (!error && post) {
    const r = await call(post, "post", budget());
    postMs = r.ms;
    postReply = r.text;
    if (!r.ok) error = r.error;
  }

  const durationMs = Date.now() - started;
  fs.writeFileSync(path.join(runDir, "conversation.json"), JSON.stringify({ prompt, conversation, sessionKey, turnTimings, post, postMs, postReply, usage }, null, 2));

  return {
    ok: !error,
    exitCode: error ? 1 : 0,
    durationMs,
    setupMs,
    setupNote: "first CLI invocation: process + agent bootstrap + opening greeting",
    turnTimings,
    postMs,
    postReply,
    usage,
    steps: totalSteps || null,
    toolFailures: totalFailures,
    text: turnTimings.map((t) => t.reply).filter(Boolean).join("\n\n") || postReply,
    humanEvents,
    error,
    raw: { conversation: path.join(runDir, "conversation.json") },
  };
}

function execCmd(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: process.platform === "win32" });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr, timedOut }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut }); });
  });
}
