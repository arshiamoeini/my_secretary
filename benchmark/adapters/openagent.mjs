import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// OpenAgent (the-open-agent/openagent) ships as a single Go binary that serves
// a web UI plus an OpenAI-compatible endpoint. There is no headless one-shot
// CLI, so each run starts one server process with the sandbox as its working
// directory and stops it afterwards. Startup is inside the measured window for
// every tool, so this stays comparable with the OpenClaw per-run process.
//
// A one-time setup (admin user + model provider + store) lives in the SQLite
// database next to the binary; the adapter only needs the store API key.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OA_DIR = process.env.OPENAGENT_DIR || path.resolve(HERE, "..", "..", "tools", "openagent");
const EXE = process.env.OPENAGENT_EXE || path.join(OA_DIR, "openagent.exe");
const API_KEY = process.env.OPENAGENT_STORE_KEY || "sk-JtByvlgilWUkh5MgXmQPlnJa";

export const meta = {
  id: "openagent",
  name: "OpenAgent v2.89.2",
  kind: "assistant",
  notes: "Go single binary, OpenAI-compatible HTTP endpoint, 10 built-in tools",
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
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });

const CONF = (port) => `appname = openagent
httpport = ${port}
runmode = dev
driverName = mysql
dataSourceName = root:123456@tcp(localhost:3306)/
dbName = casibase
redisEndpoint =
isDemoMode = false
issuer =
clientId =
clientSecret =
ipParsingMode = ""
parentDbName = ""
socks5Proxy = "127.0.0.1:10808"
logConfig = {"adapter":"console", "filename": "logs/openagent.log", "maxdays":1, "perm":"0770"}
`;

export async function run({ sandbox, prompt, runDir, timeoutMs = 300000 }) {
  fs.mkdirSync(path.join(sandbox, "conf"), { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(sandbox, "conf", "app.conf"), CONF(port), "utf8");

  const env = { ...process.env, NO_COLOR: "1" };
  const started = Date.now();
  const child = spawn(EXE, [], { cwd: sandbox, env, windowsHide: true });
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
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    httpStatus = r.status;
    const txt = await r.text();
    if (r.ok) { try { body = JSON.parse(txt); } catch { errText = txt.slice(0, 1500); } }
    else errText = txt.slice(0, 1500);
  } catch (e) {
    errText = String(e);
  }

  const durationMs = Date.now() - started;
  kill();

  // OpenAI-style usage counts cached tokens inside prompt_tokens; store
  // non-cached input separately so one cost formula covers every tool.
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

  return {
    ok: !!body,
    exitCode: body ? 0 : (httpStatus || -1),
    durationMs,
    usage,
    steps: null,
    toolFailures: null,
    text: typeof text === "string" ? text : JSON.stringify(text),
    humanEvents: [],
    error: body ? null : errText,
    raw: { stdoutTail: stdout.slice(-3000), stderrTail: stderr.slice(-3000), httpStatus },
  };
}
