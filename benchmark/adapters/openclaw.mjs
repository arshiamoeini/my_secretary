import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
