import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MODEL } from "../lib/pricing.mjs";

// Control baseline: no assistant framework at all. Just the same model, a
// generic ReAct loop and four primitive tools. Answers "how much does the
// scaffolding actually buy you?".

const BASE_URL = process.env.BENCH_BASE_URL || "https://api.avalai.ir/v1";
const API_KEY = process.env.BENCH_API_KEY || "aa-lKkP8jZXVe0Oy4157VbTANodiKRIgQWnRlrVbhX1mvsMAlrQ";

export const meta = {
  id: "vanilla",
  name: "Vanilla ReAct (control)",
  kind: "control",
  notes: "~180-line ReAct loop + read/write/list/shell tools, same model, no assistant scaffolding",
};

const tools = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files under a directory (relative to the working directory).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 text file, creating parent directories.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command in the working directory (PowerShell on Windows).",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Finish the task and return your final answer to the user.",
      parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    },
  },
];

const SYSTEM = `You are an autonomous assistant working inside a directory on a Windows machine.
You have tools: list_dir, read_file, write_file, run_shell, done.
Rules:
- Use tools to inspect the real files. Never guess file contents.
- Relative paths resolve inside the working directory.
- When the task is complete (all requested files written), call done with a short summary.
- Prefer write_file over shell heredocs.`;

function safeJoin(root, p) {
  const abs = path.resolve(root, String(p || ".").replace(/^[A-Za-z]:[\\/]/, ""));
  return abs.startsWith(path.resolve(root)) ? abs : null;
}

async function callModel(messages) {
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0 }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 400)}`);
  return JSON.parse(t);
}

function shell(cwd, command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], { cwd, windowsHide: true });
    let out = ""; let err = "";
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => { clearTimeout(t); resolve(`exit ${code}\n${out}${err}`.slice(0, 8000)); });
    child.on("error", (e) => { clearTimeout(t); resolve(`error ${e}`); });
  });
}

export async function run({ sandbox, prompt, runDir, timeoutMs = 300000 }) {
  const started = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let steps = 0;
  const transcript = [];
  const humanEvents = [];

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: prompt },
  ];

  let answer = "";
  while (steps < 30 && Date.now() - started < timeoutMs) {
    if (steps > 0) await new Promise((r) => setTimeout(r, 200));
    steps++;
    let resp;
    try {
      resp = await callModel(messages);
    } catch (e) {
      transcript.push({ role: "error", content: String(e) });
      return { ok: false, exitCode: 1, durationMs: Date.now() - started, usage, steps, text: answer, humanEvents, error: String(e), raw: { transcript } };
    }
    usage.input += resp.usage?.prompt_tokens || 0;
    usage.output += resp.usage?.completion_tokens || 0;
    usage.cacheRead += resp.usage?.prompt_tokens_details?.cached_tokens || 0;

    const msg = resp.choices?.[0]?.message || {};
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      answer = msg.content || "";
      transcript.push({ role: "assistant", content: answer });
      break;
    }
    for (const c of calls) {
      const name = c.function?.name;
      let args = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch {}
      let result = "";
      if (name === "done") { answer = args.answer || ""; result = "ok"; }
      else if (name === "list_dir") {
        const p = safeJoin(sandbox, args.path);
        try { result = p ? fs.readdirSync(p, { recursive: true }).map(String).join("\n").slice(0, 8000) : "path outside sandbox"; }
        catch (e) { result = String(e.message); }
      } else if (name === "read_file") {
        const p = safeJoin(sandbox, args.path);
        try { result = p ? fs.readFileSync(p, "utf8").slice(0, 20000) : "path outside sandbox"; }
        catch (e) { result = String(e.message); }
      } else if (name === "write_file") {
        const p = safeJoin(sandbox, args.path);
        try { if (!p) throw new Error("path outside sandbox"); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, args.content ?? "", "utf8"); result = "written"; }
        catch (e) { result = String(e.message); }
      } else if (name === "run_shell") {
        result = await shell(sandbox, args.command || "");
      } else result = "unknown tool";
      transcript.push({ role: "tool", name, args, result: String(result).slice(0, 2000) });
      messages.push({ role: "tool", tool_call_id: c.id, content: String(result) });
      if (name === "done") break;
    }
    if (answer) break;
  }

  fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  return { ok: true, exitCode: 0, durationMs: Date.now() - started, usage, steps, text: answer, humanEvents, raw: { transcript } };
}
