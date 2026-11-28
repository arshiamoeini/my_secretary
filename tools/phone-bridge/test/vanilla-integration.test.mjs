// End-to-end wiring test: the real Vanilla ReAct loop, a fake OpenAI-compatible
// server, and the local phone bridge.
//
// No network beyond 127.0.0.1, no credentials, no phone, no audio hardware.
// Simulation mode proves the agent can hold a turn-by-turn conversation; the
// approval gate proves an agent cannot dial a real person on its own.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vanilla-phone-"));

function completion(message) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ index: 0, finish_reason: "tool_calls", message }],
  };
}

function toolCall(id, name, args) {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion(handler(requests.length, parsed))));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  process.env.BENCH_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    return await fn(requests);
  } finally {
    server.close();
  }
}

test("without PHONE_TOOL nothing changes, keeping benchmark parity", async () => {
  delete process.env.PHONE_TOOL;

  const requests = await withServer(() => toolCall("done_1", "done", { answer: "ok" }), async (captured) => {
    const adapter = await import(`../../../benchmark/adapters/vanilla.mjs?parity=${Date.now()}`);
    const sandbox = path.join(tmp, "sandbox-off");
    const runDir = path.join(tmp, "run-off");
    fs.mkdirSync(sandbox, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });

    const result = await adapter.run({ sandbox, prompt: "Do nothing.", runDir, timeoutMs: 10000 });
    assert.equal(result.ok, true);
    return captured;
  });

  assert.deepEqual(
    requests[0].tools.map((tool) => tool.function.name),
    ["list_dir", "read_file", "write_file", "run_shell", "done"],
  );
  assert.equal(requests[0].messages[0].content.includes("phone_call"), false);
  assert.equal(requests[0].messages[0].content.includes("local SIM"), false);
});

test("Vanilla runs a simulated call: dial, listen, say, hang up", async () => {
  process.env.PHONE_TOOL = "1";
  process.env.PHONE_SIMULATE = "1";
  process.env.PHONE_SCRIPT = "سلام، بفرمایید.\nفردا ساعت ده خوبه.";
  process.env.PHONE_AUDIT_DIR = path.join(tmp, "audit-sim");
  delete process.env.PHONE_ALLOW_DIAL;
  delete process.env.PHONE_DRY_RUN;

  const script = [
    () => toolCall("c1", "phone_call", { to: "0912 123 4567", greeting: "سلام، دفتر مدرسه تماس می‌گیرم." }),
    () => toolCall("c2", "phone_listen", { seconds: 4 }),
    () => toolCall("c3", "phone_say", { text: "بله، فردا ساعت ده در دفتر منتظر شما هستیم." }),
    () => toolCall("c4", "phone_hangup", {}),
    () => toolCall("c5", "phone_status", {}),
    () => toolCall("c6", "done", { answer: "call handled" }),
  ];

  const requests = await withServer((turn) => script[turn - 1](), async (captured) => {
    const adapter = await import(`../../../benchmark/adapters/vanilla.mjs?sim=${Date.now()}`);
    const sandbox = path.join(tmp, "sandbox-sim");
    const runDir = path.join(tmp, "run-sim");
    fs.mkdirSync(sandbox, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });

    const result = await adapter.run({ sandbox, prompt: "Call the parent back.", runDir, timeoutMs: 15000 });
    assert.equal(result.ok, true);
    assert.equal(result.text, "call handled");
    return captured;
  });

  assert.deepEqual(
    requests[0].tools.map((tool) => tool.function.name),
    ["list_dir", "read_file", "write_file", "run_shell", "done", "phone_call", "phone_say", "phone_listen", "phone_status", "phone_hangup"],
  );
  assert.match(requests[0].messages[0].content, /Phone calls \(local SIM, Iran\)/);

  const dirs = fs.readdirSync(tmp).filter((name) => name.startsWith("run-sim"));
  const runDir = path.join(tmp, dirs[0]);
  const transcript = JSON.parse(fs.readFileSync(path.join(runDir, "transcript.json"), "utf8"));
  const entry = (name) => transcript.find((item) => item.name === name);

  const placed = JSON.parse(entry("phone_call").result);
  assert.equal(placed.ok, true);
  assert.equal(placed.state, "SIMULATED");
  assert.equal(placed.to.national, "09121234567");

  const heard = JSON.parse(entry("phone_listen").result);
  assert.equal(heard.text, "سلام، بفرمایید.");

  const replied = JSON.parse(entry("phone_say").result);
  assert.equal(replied.ok, true);

  const ended = JSON.parse(entry("phone_hangup").result);
  assert.equal(ended.ok, true);
  assert.match(ended.transcript, /Caller: سلام، بفرمایید\./);

  const after = JSON.parse(entry("phone_status").result);
  assert.equal(after.state, "IDLE");
});

test("a long transcript is dropped, not cut, so the model always gets valid JSON", async () => {
  process.env.PHONE_TOOL = "1";
  process.env.PHONE_SIMULATE = "1";
  const longLine = "این یک جمله بسیار طولانی برای آزمون اندازهٔ نتیجهٔ ابزار است. ".repeat(12);
  process.env.PHONE_SCRIPT = [longLine, longLine, longLine].join("\n");
  process.env.PHONE_AUDIT_DIR = path.join(tmp, "audit-long");
  delete process.env.PHONE_ALLOW_DIAL;

  const script = [
    () => toolCall("l1", "phone_call", { to: "09121234567", greeting: "سلام، دفتر مدرسه." }),
    () => toolCall("l2", "phone_listen", {}),
    () => toolCall("l3", "phone_listen", {}),
    () => toolCall("l4", "phone_listen", {}),
    () => toolCall("l5", "phone_hangup", {}),
    () => toolCall("l6", "done", { answer: "ok" }),
  ];

  await withServer((turn) => script[turn - 1](), async () => {
    const adapter = await import(`../../../benchmark/adapters/vanilla.mjs?long=${Date.now()}`);
    const sandbox = path.join(tmp, "sandbox-long");
    const runDir = path.join(tmp, "run-long");
    fs.mkdirSync(sandbox, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    const result = await adapter.run({ sandbox, prompt: "Long call.", runDir, timeoutMs: 15000 });
    assert.equal(result.ok, true);
  });

  const transcript = JSON.parse(fs.readFileSync(path.join(tmp, "run-long", "transcript.json"), "utf8"));
  const ended = transcript.find((item) => item.name === "phone_hangup");
  assert.ok(ended.result.length <= 2000, "tool result must respect the loop cap");

  const parsed = JSON.parse(ended.result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.turns, 5, "greeting + 3 caller lines + AI disclosure");
  assert.equal(parsed.transcript, undefined, "the bulky transcript is dropped instead of truncating the JSON");
});

test("a real dial stays blocked unless the operator approves it", async () => {
  process.env.PHONE_TOOL = "1";
  delete process.env.PHONE_SIMULATE;
  delete process.env.PHONE_ALLOW_DIAL;
  delete process.env.PHONE_DRY_RUN;
  process.env.PHONE_AUDIT_DIR = path.join(tmp, "audit-gate");

  const script = [
    () => toolCall("g1", "phone_call", { to: "+989121234567", greeting: "سلام" }),
    () => toolCall("g2", "done", { answer: "blocked as expected" }),
  ];

  const requests = await withServer((turn) => script[turn - 1](), async (captured) => {
    const adapter = await import(`../../../benchmark/adapters/vanilla.mjs?gate=${Date.now()}`);
    const sandbox = path.join(tmp, "sandbox-gate");
    const runDir = path.join(tmp, "run-gate");
    fs.mkdirSync(sandbox, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });

    const result = await adapter.run({ sandbox, prompt: "Call this number.", runDir, timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.equal(result.text, "blocked as expected");
    return captured;
  });

  assert.equal(requests[0].tools.some((tool) => tool.function.name === "phone_call"), true);

  const transcript = JSON.parse(fs.readFileSync(path.join(tmp, "run-gate", "transcript.json"), "utf8"));
  const blockedCall = transcript.find((item) => item.name === "phone_call");
  const blocked = JSON.parse(blockedCall.result);

  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.code, "dial-not-approved");
  assert.equal(blocked.to.national, "09121234567");
});
