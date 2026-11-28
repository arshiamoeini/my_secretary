import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { firstCallerMessage, emptyUsage, addUsage, usageDelta, openAIUsage } from "../lib/conversation.mjs";

// CowAgent has no one-shot CLI, so it is driven through the OpenAI-compatible
// HTTP endpoint it exposes when `external_api_enabled` is on. One server
// process per run keeps every run sandboxed and makes startup cost comparable
// to OpenClaw's per-run `agent --local` process.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COW_DIR = process.env.COWAGENT_DIR || path.resolve(HERE, "..", "..", "tools", "CowAgent");
const PY = process.env.COWAGENT_PY || path.join(COW_DIR, ".venv", "Scripts", "python.exe");
const API_KEY = process.env.BENCH_API_KEY || "aa-lKkP8jZXVe0Oy4157VbTANodiKRIgQWnRlrVbhX1mvsMAlrQ";
const BASE_URL = process.env.BENCH_BASE_URL || "https://api.avalai.ir/v1";

export const meta = {
  id: "cowagent",
  name: "CowAgent (d5c17e0)",
  kind: "assistant",
  notes: "Python agent harness, OpenAI-compatible HTTP endpoint, full-access permission mode",
};

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });

const waitPort = (port, timeoutMs) =>
  new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });

function writeConfig({ dataDir, sandbox, port, token }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = {
    channel_type: "web",
    web_host: "127.0.0.1",
    web_port: port,
    web_password: "",
    bot_type: "custom",
    model: "deepseek-chat",
    custom_api_key: API_KEY,
    custom_api_base: BASE_URL,
    agent: true,
    agent_workspace: sandbox,
    agent_permission_mode: "full-access",
    agent_max_steps: 40,
    agent_max_context_turns: 30,
    enable_thinking: false,
    external_api_enabled: true,
    external_api_token: token,
    knowledge: false,
    self_evolution_enabled: false,
    subagent: { enabled: false },
    speech_recognition: false,
    voice_reply_voice: false,
    plugins: { enabled: false },
    debug: false,
  };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));
  return path.join(dataDir, "config.json");
}

export async function run({ sandbox, prompt, runDir, timeoutMs = 300000 }) {
  const dataDir = path.join(runDir, "data");
  const port = await freePort();
  const token = "bench-" + Math.random().toString(36).slice(2);
  writeConfig({ dataDir, sandbox, port, token });

  const env = {
    ...process.env,
    COW_DATA_DIR: dataDir,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    NO_COLOR: "1",
  };

  const started = Date.now();
  const child = spawn(PY, ["app.py"], { cwd: COW_DIR, env, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const kill = () => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    } catch { /* ignore */ }
  };

  const up = await waitPort(port, Math.min(120000, timeoutMs));
  if (!up) {
    kill();
    return {
      ok: false, exitCode: -1, durationMs: Date.now() - started, usage: null, steps: null,
      text: "", humanEvents: [], error: "server did not start",
      raw: { stdoutTail: stdout.slice(-3000), stderrTail: stderr.slice(-3000) },
    };
  }

  let body = null;
  let httpStatus = 0;
  let errText = "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(30000, timeoutMs - (Date.now() - started)));
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    httpStatus = r.status;
    errText = r.ok ? "" : (await r.text()).slice(0, 1500);
    if (r.ok) body = await r.json();
  } catch (e) {
    errText = String(e);
  }

  const durationMs = Date.now() - started;
  kill();

  // OpenAI-style usage counts cached tokens inside prompt_tokens. The rest of
  // the harness stores non-cached input separately (Anthropic style), so
  // subtract here to keep one cost formula across all tools.
  const u = body?.usage;
  const cached = u?.prompt_tokens_details?.cached_tokens || 0;
  const usage = u
    ? {
        input: Math.max((u.prompt_tokens || 0) - cached, 0),
        output: u.completion_tokens || 0,
        cacheRead: cached,
        cacheWrite: 0,
      }
    : null;

  const text = body?.choices?.[0]?.message?.content || "";
  const steps = body?.cowagent?.steps ?? body?.usage?.steps ?? null;

  return {
    ok: !!body,
    exitCode: body ? 0 : (httpStatus || -1),
    durationMs,
    usage,
    steps,
    toolFailures: null,
    text: typeof text === "string" ? text : JSON.stringify(text),
    humanEvents: [],
    error: body ? null : errText,
    raw: { stdoutTail: stdout.slice(-3000), stderrTail: stderr.slice(-3000), httpStatus },
  };
}

async function postChat(port, token, messages, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(30000, timeoutMs));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages, stream: false }),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, status: r.status, error: txt.slice(0, 1500) };
    try {
      return { ok: true, status: r.status, body: JSON.parse(txt) };
    } catch {
      return { ok: false, status: r.status, error: txt.slice(0, 1500) };
    }
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Interactive phone-call mode: start one server, then send each caller turn as
 * a separate chat completion. Server startup is timed as `setupMs`; every
 * caller->agent exchange gets its own `ms`. The post-call file-writing turn is
 * timed separately as `postMs`.
 */
export async function converse({ sandbox, prompt, conversation, post, runDir, timeoutMs = 300000 }) {
  const dataDir = path.join(runDir, "data");
  const port = await freePort();
  const token = "bench-" + Math.random().toString(36).slice(2);
  writeConfig({ dataDir, sandbox, port, token });

  const env = {
    ...process.env,
    COW_DATA_DIR: dataDir,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    NO_COLOR: "1",
  };

  const started = Date.now();
  const child = spawn(PY, ["app.py"], { cwd: COW_DIR, env, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const kill = () => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    } catch { /* ignore */ }
  };

  const up = await waitPort(port, Math.min(120000, timeoutMs));
  const setupMs = Date.now() - started;
  if (!up) {
    kill();
    return {
      ok: false, exitCode: -1, durationMs: Date.now() - started, setupMs,
      usage: null, steps: null, text: "", humanEvents: [], turnTimings: [], postMs: null, postReply: "",
      error: "server did not start",
      raw: { stdoutTail: stdout.slice(-3000), stderrTail: stderr.slice(-3000) },
    };
  }

  const usage = emptyUsage();
  const turnTimings = [];
  let totalSteps = 0;
  let error = null;
  let lastReply = "";
  const messages = [{ role: "user", content: firstCallerMessage(prompt, conversation[0]) }];

  for (let i = 0; i < conversation.length; i++) {
    if (i > 0) messages.push({ role: "user", content: conversation[i] });
    const before = { ...usage };
    const t0 = Date.now();
    const r = await postChat(port, token, messages, timeoutMs - (Date.now() - started));
    const ms = Date.now() - t0;
    if (!r.ok) { error = r.error; break; }
    const u = openAIUsage(r.body);
    addUsage(usage, u);
    const reply = r.body?.choices?.[0]?.message?.content || "";
    if (typeof reply !== "string") lastReply = JSON.stringify(reply);
    else lastReply = reply;
    messages.push({ role: "assistant", content: lastReply });
    totalSteps += r.body?.cowagent?.steps ?? r.body?.usage?.steps ?? 0;
    turnTimings.push({ turn: i, caller: conversation[i], reply: lastReply, ms, usage: u ? usageDelta(before, usage) : null });
  }

  let postMs = null;
  let postReply = "";
  if (!error && post) {
    messages.push({ role: "user", content: post });
    const before = { ...usage };
    const t0 = Date.now();
    const r = await postChat(port, token, messages, timeoutMs - (Date.now() - started));
    postMs = Date.now() - t0;
    if (!r.ok) error = r.error;
    else {
      const u = openAIUsage(r.body);
      addUsage(usage, u);
      postReply = r.body?.choices?.[0]?.message?.content || "";
      totalSteps += r.body?.cowagent?.steps ?? r.body?.usage?.steps ?? 0;
    }
  }

  const durationMs = Date.now() - started;
  kill();

  fs.writeFileSync(path.join(runDir, "conversation.json"), JSON.stringify({ prompt, conversation, turnTimings, post, postMs, postReply, usage }, null, 2));
  return {
    ok: !error,
    exitCode: error ? 1 : 0,
    durationMs,
    setupMs,
    setupNote: "server startup (port ready) before the first caller turn",
    turnTimings,
    postMs,
    postReply,
    usage,
    steps: totalSteps || null,
    toolFailures: null,
    text: turnTimings.map((t) => t.reply).filter(Boolean).join("\n\n") || postReply,
    humanEvents: [],
    error,
    raw: { stdoutTail: stdout.slice(-3000), stderrTail: stderr.slice(-3000) },
  };
}
