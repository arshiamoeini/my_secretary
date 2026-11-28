import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { MODEL } from "../lib/pricing.mjs";

// Control baseline: no assistant framework at all. Just the same model, a
// generic ReAct loop and four primitive tools. Answers "how much does the
// scaffolding actually buy you?".

const BASE_URL = process.env.BENCH_BASE_URL || "https://api.avalai.ir/v1";
const API_KEY = process.env.BENCH_API_KEY || "aa-lKkP8jZXVe0Oy4157VbTANodiKRIgQWnRlrVbhX1mvsMAlrQ";

// Real outbound calling is opt-in so the benchmark stays reproducible and
// costs nothing unless the operator explicitly enables it.
const PHONE_ENABLED = process.env.PHONE_TOOL === "1";

// The phone-bridge call benchmark sweeps alternative models through the same
// loop (BENCH_MODEL wins for the sweep). For phone work the pinned brain from
// phone.config.json / PHONE_MODEL is used. With PHONE_TOOL unset the module
// never touches bridge config, so benchmark parity (same model, same tools,
// same prompt) is intact by construction.
let MODEL_ID = MODEL;
if (process.env.BENCH_MODEL) MODEL_ID = process.env.BENCH_MODEL;
else if (PHONE_ENABLED) {
  if (process.env.PHONE_MODEL) MODEL_ID = process.env.PHONE_MODEL;
  else {
    try {
      const { loadConfig } = await import("../../tools/phone-bridge/src/config.mjs");
      MODEL_ID = loadConfig().agent.model || MODEL;
    } catch {
      // unreadable config file: fall back to the matrix model
    }
  }
}

export const meta = {
  id: "vanilla",
  name: "Vanilla ReAct (control)",
  kind: "control",
  notes: "~180-line ReAct loop + read/write/list/shell tools, same model, no assistant scaffolding",
};

const baseTools = [
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

const phoneTools = PHONE_ENABLED
  ? [
      {
        type: "function",
        function: {
          name: "phone_call",
          description:
            "Dial a real Iranian number through the SIM in the operator's phone (ADB + the phone's own dialer) and optionally speak `greeting` with local Persian TTS. No telephony API and no per-minute fee, but it is a real call to a real person: it is blocked unless the operator sets PHONE_ALLOW_DIAL=1, the number passes PHONE_ALLOWLIST, and the hourly call cap is not reached. Set dry_run=true to validate and log without dialing.",
          parameters: {
            type: "object",
            properties: {
              to: { type: "string", description: "Iranian mobile or landline, e.g. 09121234567, 02112345678 or +989121234567" },
              greeting: { type: "string", description: "First sentences to speak once the call connects. Keep it under 1200 characters." },
              dry_run: { type: "boolean", description: "Validate the number and log the intent without dialing." },
            },
            required: ["to"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "phone_say",
          description:
            "Speak `text` into the active call using local text-to-speech. Returns the voice and any warning (for example, no Persian voice installed).",
          parameters: {
            type: "object",
            properties: { text: { type: "string", description: "Words to speak. One or two short sentences." } },
            required: ["text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "phone_listen",
          description:
            "Record the other party for a few seconds and transcribe it locally. Returns `text`; an empty text means silence or that no local STT engine is configured — never assume what the caller said.",
          parameters: {
            type: "object",
            properties: { seconds: { type: "number", description: "Recording length, 2–30 seconds. Defaults to PHONE_LISTEN_SECONDS." } },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "phone_status",
          description: "Report the active call session and reconcile it with the phone's live telephony state. A call that ended on the phone is archived and reported as IDLE.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "phone_hangup",
          description: "End the active call and archive its transcript. Always call this when the conversation is over.",
          parameters: { type: "object", properties: {} },
        },
      },
    ]
  : [];


const PHONE_TOOL_NAMES = new Set(phoneTools.map((tool) => tool.function.name));
const tools = [...baseTools, ...phoneTools];

/**
 * Tool results are capped at 2000 characters in the loop. Cutting JSON in half
 * hands the model an unparseable blob, so drop the bulky extras first.
 */
function phoneResult(value) {
  const text = JSON.stringify(value);
  if (text.length <= 2000) return text;
  const { transcript, archive, preview, ...rest } = value ?? {};
  const compact = JSON.stringify(rest);
  return compact.length <= 2000 ? compact : compact.slice(0, 2000);
}

const SYSTEM = `You are an autonomous assistant working inside a directory on a Windows machine.
You have tools: ${["list_dir", "read_file", "write_file", "run_shell", "done", ...phoneTools.map((t) => t.function.name)].join(", ")}.
Rules:
- Use tools to inspect the real files. Never guess file contents.
- Relative paths resolve inside the working directory.
- When the task is complete (all requested files written), call done with a short summary.
- Prefer write_file over shell heredocs.${
  PHONE_ENABLED
    ? `

Phone calls (local SIM, Iran):
- phone_call dials a real number through the phone's own SIM and speaks \`greeting\` with local TTS. There is no telephony API and no per-minute fee, but it is a real call to a real person.
- If phone_call returns "blocked" (dial-not-approved, not-allowlisted, call-cap), report the reason and stop. Never try to work around a gate.
- Use dry_run=true first when the number or wording is uncertain.
- Hold a turn-by-turn conversation: phone_listen to hear the caller, then phone_say to reply. Keep every reply to one or two short sentences.
- An empty phone_listen text means silence or that no local STT engine is installed. Say a short prompt and listen again; never invent what the caller said.
- Always finish with phone_hangup so no call is left open.
- phone_status reconciles the session with the phone's live state.
- Only dial numbers the user supplied or that appear in the office records. Never call a number just to test the tool.`
    : ""
}`;

function safeJoin(root, p) {
  const abs = path.resolve(root, String(p || ".").replace(/^[A-Za-z]:[\\/]/, ""));
  return abs.startsWith(path.resolve(root)) ? abs : null;
}

async function callModel(messages) {
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL_ID, messages, tools, tool_choice: "auto", temperature: 0 }),
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

function usageDelta(before, after) {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
  };
}

function firstCallerMessage(prompt, firstTurn) {
  return `${prompt}\n\n[The phone rings. You pick up.]\nCaller: ${firstTurn}`;
}

/**
 * Run one conversational turn: send the current message history, execute any
 * tool calls until the model produces a final reply, and mutate `messages`.
 * The loop stops at a final assistant message or at the `done` tool.
 */
async function reactTurn({ sandbox, messages, deadline, usage, transcript }) {
  let answer = "";
  let steps = 0;
  let viaDone = false;
  let error = null;
  while (steps < 30 && Date.now() < deadline) {
    if (steps > 0) await new Promise((r) => setTimeout(r, 200));
    steps++;
    let resp;
    const calledAt = Date.now();
    try {
      resp = await callModel(messages);
    } catch (e) {
      transcript.push({ role: "error", content: String(e) });
      return { answer, steps, viaDone, error: String(e) };
    }
    // Additive timing metadata for tools/phone-bridge/bench (model latency per
    // step). It never changes the tools array or the system prompt, so the
    // PHONE_TOOL-unset parity assertion in the phone-bridge tests still holds.
    transcript.push({ role: "meta", kind: "model_call", ms: Date.now() - calledAt, model: MODEL_ID });
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
      if (name === "done") { answer = args.answer || ""; result = "ok"; viaDone = true; }
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
      } else if (PHONE_ENABLED && PHONE_TOOL_NAMES.has(name)) {
        try {
          const bridge = await import("../../tools/phone-bridge/src/index.mjs");
          const { loadConfig } = await import("../../tools/phone-bridge/src/config.mjs");
          const config = loadConfig();
          let call;
          if (name === "phone_call") {
            call = await bridge.dial({
              to: args.to,
              greeting: args.greeting ?? args.text,
              dryRun: Boolean(args.dry_run),
              config,
            });
          } else if (name === "phone_say") {
            call = await bridge.say({ text: args.text, config });
          } else if (name === "phone_listen") {
            call = await bridge.listen({ seconds: args.seconds, config });
          } else if (name === "phone_hangup") {
            call = await bridge.hangup({ config });
          } else {
            call = await bridge.status({ config });
          }
          result = phoneResult(call);
        } catch (e) {
          result = `phone bridge error: ${e.message}`;
        }
      } else result = "unknown tool";
      transcript.push({ role: "tool", name, args, result: String(result).slice(0, 2000) });
      messages.push({ role: "tool", tool_call_id: c.id, content: String(result) });
      if (viaDone) break;
    }
    if (answer || viaDone) break;
  }
  return { answer, steps, viaDone, error };
}

export async function run({ sandbox, prompt, runDir, timeoutMs = 300000 }) {
  const started = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const transcript = [];
  const humanEvents = [];

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: prompt },
  ];

  const turn = await reactTurn({ sandbox, messages, deadline: started + timeoutMs, usage, transcript });
  fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  return {
    ok: !turn.error,
    exitCode: turn.error ? 1 : 0,
    durationMs: Date.now() - started,
    usage,
    steps: turn.steps,
    text: turn.answer,
    humanEvents,
    error: turn.error,
    raw: { transcript },
  };
}

/**
 * Interactive phone-call mode for tasks with a `conversation` array. Each
 * caller turn is sent as a separate user message; the agent's spoken reply is
 * recorded with its own wall-clock time. The post-call turn is timed separately
 * so "time per answer" is not mixed with file-writing time.
 */
export async function converse({ sandbox, prompt, conversation, post, runDir, timeoutMs = 300000 }) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const transcript = [];
  const humanEvents = [];
  const turnTimings = [];
  let totalSteps = 0;
  let error = null;

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: firstCallerMessage(prompt, conversation[0]) },
  ];

  for (let i = 0; i < conversation.length; i++) {
    if (i > 0) messages.push({ role: "user", content: conversation[i] });
    const before = { ...usage };
    const t0 = Date.now();
    const r = await reactTurn({ sandbox, messages, deadline, usage, transcript });
    const ms = Date.now() - t0;
    totalSteps += r.steps;
    if (r.error) { error = r.error; break; }
    if (r.viaDone && r.answer) messages.push({ role: "assistant", content: r.answer });
    turnTimings.push({
      turn: i,
      caller: conversation[i],
      reply: r.answer,
      ms,
      usage: usageDelta(before, usage),
      viaDone: r.viaDone,
    });
  }

  let postMs = null;
  let postReply = "";
  if (!error && post) {
    messages.push({ role: "user", content: post });
    const before = { ...usage };
    const t0 = Date.now();
    const r = await reactTurn({ sandbox, messages, deadline, usage, transcript });
    postMs = Date.now() - t0;
    totalSteps += r.steps;
    if (r.error) error = r.error;
    else postReply = r.answer;
  }

  fs.writeFileSync(path.join(runDir, "conversation.json"), JSON.stringify({ prompt, conversation, turnTimings, post, postMs, postReply, usage }, null, 2));
  fs.writeFileSync(path.join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  return {
    ok: !error,
    exitCode: error ? 1 : 0,
    durationMs: Date.now() - started,
    setupMs: 0,
    setupNote: "in-process; no server startup",
    turnTimings,
    postMs,
    postReply,
    usage,
    steps: totalSteps,
    text: turnTimings.map((t) => t.reply).filter(Boolean).join("\n\n") || postReply,
    humanEvents,
    error,
    raw: { transcript },
  };
}
