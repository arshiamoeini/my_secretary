// Offline tests for end-of-turn detection (PHONE_LISTEN_UNTIL_SILENCE) and the
// WAV helpers it uses. Synthetic PCM files; no hardware, no network.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeWav16, trailingSilenceMs, concatWavFiles } from "../src/local/wav.mjs";
import { dial, listen } from "../src/index.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-vad-"));
const SR = 16000;

function tone(seconds, amp) {
  const n = Math.round(seconds * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i += 1) s[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return s;
}

function silent(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

function writeChunk(name, parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const merged = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    merged.set(p, at);
    at += p.length;
  }
  const file = path.join(tmp, `${name}.wav`);
  fs.writeFileSync(file, encodeWav16(merged, SR));
  return { file, duration: total / SR };
}

const loudThenQuiet = writeChunk("speech-then-silence", [tone(0.5, 0.3), silent(1.5)]);
const loud = writeChunk("loud", [tone(1.5, 0.3), tone(0.5, 0.3)]);
const quiet = writeChunk("quiet", [silent(2)]);

test("trailingSilenceMs measures the silent tail and rejects missing files", () => {
  assert.ok(trailingSilenceMs(loudThenQuiet.file, { threshold: 0.004 }) >= 1400);
  assert.equal(trailingSilenceMs(loud.file, { threshold: 0.004 }), 0);
  assert.ok(trailingSilenceMs(quiet.file, { threshold: 0.004 }) >= 1900);
  assert.equal(trailingSilenceMs(path.join(tmp, "missing.wav")), 0);
});

test("concatWavFiles joins chunks at 16 kHz", () => {
  const out = path.join(tmp, "merged.wav");
  const merged = concatWavFiles([loud.file, loudThenQuiet.file], out, { sampleRate: SR });
  assert.equal(merged.ok, true);
  assert.equal(merged.parts, 2);
  assert.ok(Math.abs(merged.duration - 4) < 0.01, String(merged.duration));
  fs.unlinkSync(out);
});

function vadEnv(auditDir, extra = {}) {
  const keys = {
    PHONE_TOOL: "1",
    PHONE_SIMULATE: "",
    PHONE_DRY_RUN: "",
    PHONE_ALLOW_DIAL: "1",
    PHONE_ALLOWLIST: "09121234567",
    PHONE_AUDIT_DIR: auditDir,
    PHONE_LISTEN_UNTIL_SILENCE: "1",
    ...extra,
  };
  for (const [k, v] of Object.entries(keys)) {
    if (v === "") delete process.env[k];
    else process.env[k] = v;
  }
}

test("listen stops at end-of-turn instead of the fixed window", async () => {
  const auditDir = path.join(tmp, "audit-vad");
  vadEnv(auditDir);

  let recordCalls = 0;
  let transcribedFile = null;
  const deps = {
    dial: async () => ({ ok: true, answered: true, device: { serial: "T", model: "T", state: "device" } }),
    hangup: async () => ({ ok: true, code: "hung-up", state: "IDLE" }),
    callState: async () => ({ ok: true, state: "OFFHOOK" }),
    deviceStatus: async () => ({ ok: true, model: "T", serial: "T", state: "device" }),
    synthesize: async () => ({ ok: true, path: loud.file, engine: "t", voice: "v" }),
    play: async () => ({ ok: true, backend: "t", duration: 2 }),
    record: async () => {
      recordCalls += 1;
      const src = recordCalls === 1 ? loud : loudThenQuiet;
      const copy = path.join(tmp, `rec-${recordCalls}.wav`);
      fs.copyFileSync(src.file, copy);
      return { ok: true, path: copy, duration: src.duration, rms: 0.2, hasSpeech: true, backend: "fake" };
    },
    transcribe: async (_config, file) => {
      transcribedFile = file;
      return { ok: true, text: "سلام، بفرمایید" };
    },
  };

  const config = (await import("../src/config.mjs")).loadConfig();
  const started = await dial({ to: "09121234567", config, deps });
  assert.equal(started.ok, true, JSON.stringify(started));

  const heard = await listen({ seconds: 8, config, deps });
  assert.equal(heard.ok, true, JSON.stringify(heard));
  assert.equal(heard.text, "سلام، بفرمایید");
  assert.equal(recordCalls, 2, "must stop after the silent tail, not after 8 s");
  assert.equal(heard.vad?.stoppedEarly, true);
  assert.ok(heard.vad.trailingSilenceMs >= 1400);
  assert.equal(heard.seconds, 4, "reported time is what was actually recorded");
  assert.ok(transcribedFile, "STT ran on the merged capture");
  assert.ok(fs.existsSync(transcribedFile) === false, "chunk temp files are cleaned up");

  const { hangup } = await import("../src/index.mjs");
  const ended = await hangup({ config, deps });
  assert.equal(ended.ok, true);
  delete process.env.PHONE_LISTEN_UNTIL_SILENCE;
});

test("without the flag, listen keeps the single fixed-window record", async () => {
  const auditDir = path.join(tmp, "audit-fixed");
  vadEnv(auditDir, { PHONE_LISTEN_UNTIL_SILENCE: "" });
  delete process.env.PHONE_LISTEN_UNTIL_SILENCE;

  let recordCalls = 0;
  const deps = {
    dial: async () => ({ ok: true, answered: true, device: { serial: "T", model: "T", state: "device" } }),
    hangup: async () => ({ ok: true, code: "hung-up", state: "IDLE" }),
    callState: async () => ({ ok: true, state: "OFFHOOK" }),
    deviceStatus: async () => ({ ok: true, model: "T", serial: "T", state: "device" }),
    synthesize: async () => ({ ok: true, path: loud.file, engine: "t", voice: "v" }),
    play: async () => ({ ok: true, backend: "t", duration: 2 }),
    record: async () => {
      recordCalls += 1;
      const copy = path.join(tmp, "fixed-rec.wav");
      fs.copyFileSync(loud.file, copy);
      return { ok: true, path: copy, duration: 2, rms: 0.2, hasSpeech: true, backend: "fake" };
    },
    transcribe: async () => ({ ok: true, text: "خب" }),
  };

  const config = (await import("../src/config.mjs")).loadConfig();
  const started = await dial({ to: "09121234567", config, deps });
  assert.equal(started.ok, true);
  const heard = await listen({ seconds: 6, config, deps });
  assert.equal(heard.ok, true);
  assert.equal(recordCalls, 1, "fixed window: exactly one record call");
  assert.equal(heard.vad, null);
  const { hangup } = await import("../src/index.mjs");
  await hangup({ config, deps });
});

test("dead air stops at 4 s instead of the full window", async () => {
  const auditDir = path.join(tmp, "audit-dead");
  vadEnv(auditDir);

  let recordCalls = 0;
  const deps = {
    dial: async () => ({ ok: true, answered: true, device: { serial: "T", model: "T", state: "device" } }),
    hangup: async () => ({ ok: true, code: "hung-up", state: "IDLE" }),
    callState: async () => ({ ok: true, state: "OFFHOOK" }),
    deviceStatus: async () => ({ ok: true, model: "T", serial: "T", state: "device" }),
    synthesize: async () => ({ ok: true, path: loud.file, engine: "t", voice: "v" }),
    play: async () => ({ ok: true, backend: "t", duration: 2 }),
    record: async () => {
      recordCalls += 1;
      const copy = path.join(tmp, `dead-${recordCalls}.wav`);
      fs.copyFileSync(quiet.file, copy);
      return { ok: true, path: copy, duration: 2, rms: 0, hasSpeech: false, backend: "fake" };
    },
    transcribe: async () => ({ ok: true, text: "" }),
  };

  const config = (await import("../src/config.mjs")).loadConfig();
  const started = await dial({ to: "09121234567", config, deps });
  assert.equal(started.ok, true);
  const heard = await listen({ seconds: 8, config, deps });
  assert.equal(heard.ok, true);
  assert.equal(recordCalls, 2, "silence must be reported after ~4 s, not 8 s");
  assert.equal(heard.empty, true);
  assert.equal(heard.hasSpeech, false);
  const { hangup } = await import("../src/index.mjs");
  await hangup({ config, deps });
  delete process.env.PHONE_LISTEN_UNTIL_SILENCE;
});
