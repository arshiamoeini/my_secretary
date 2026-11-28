// Offline tests for the Aval.ai voice engines.
//
// No network, no key: a local http server plays the role of api.avalai.ir and
// every assertion is about what the bridge does with the answer — including the
// failure modes that matter on a live call (silent stub audio, 401, timeout,
// empty transcript, budget overrun) and the one thing that must never happen:
// the API key reaching an audit log.

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { pcm16ToWav, redactSecret, speak, hear, avalStatus, estimateUsd, wavBytes, resetPricingCache } from "../src/local/aval.mjs";
import { synthesize } from "../src/local/tts.mjs";
import { transcribe, sttStatus } from "../src/local/stt.mjs";
import { dial, say, listen, hangup, resetCallCount, voiceSpend } from "../src/index.mjs";
import { probeWav, encodeWav16 } from "../src/local/wav.mjs";

const KEY = "aa-TESTKEY-not-a-real-secret";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aval-voice-"));

function fakeVoice({ sampleRate = 24000, seconds = 0.5, mode = "pcm" } = {}) {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 20) * 0.3;
  return mode === "pcm" ? Buffer.from(encodeWav16(samples, sampleRate).subarray(44)) : encodeWav16(samples, sampleRate);
}

/** A stand-in for the Aval audio endpoints; `behaviour` picks what it returns. */
function startStub(behaviour = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (behaviour.hang) {
        req.socket.end();
        return;
      }
      if (behaviour.slow) {
        // never answers, so the client's own timeout has to be what stops it
        return;
      }
      if (req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: behaviour.models ?? [{ id: "eleven_flash_v2_5", mode: "audio_speech", pricing: { output_cost_per_second: 0.0025 } }, { id: "gpt-4o-mini-transcribe", mode: "audio_transcription", pricing: { input_cost_per_second: 0.00005 } }] }));
        return;
      }
      if (req.url === "/audio/speech") {
        if (behaviour.ttsStatus) {
          res.writeHead(behaviour.ttsStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `no such voice with key ${KEY}` } }));
          return;
        }
        if (behaviour.ttsTiny) {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(Buffer.alloc(12));
          return;
        }
        if (behaviour.rawPayload) {
          res.writeHead(200, { "content-type": behaviour.ttsType || "audio/mpeg" });
          res.end(Buffer.from(behaviour.rawPayload));
          return;
        }
        const json = JSON.parse(body.toString("utf8"));
        res.writeHead(200, { "content-type": behaviour.ttsType || "application/octet-stream" });
        res.end(fakeVoice({ seconds: behaviour.ttsSeconds ?? 0.5, mode: json.response_format === "wav" ? "wav" : "pcm" }));
        return;
      }
      if (req.url === "/audio/transcriptions") {
        if (behaviour.sttStatus) {
          res.writeHead(behaviour.sttStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "quota exceeded" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: behaviour.sttText ?? "سلام، من پدر علی هستم" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unexpected " + req.url } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        seen,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function avalConfig(stub, extra = {}) {
  const config = loadConfig({
    PHONE_AUDIT_DIR: path.join(tmp, `audit-${Math.random().toString(36).slice(2)}`),
    AVAL_API_KEY: KEY,
    AVAL_BASE_URL: stub.baseUrl,
    PHONE_TTS_ENGINE: "aval",
    PHONE_STT_ENGINE: "aval",
    PHONE_AVAL_TTS_MODEL: "eleven_flash_v2_5",
    PHONE_AVAL_STT_MODEL: "gpt-4o-mini-transcribe",
    PHONE_ALLOW_DIAL: "1",
    ...extra,
  });
  config.aval.fetchImpl = globalThis.fetch;
  return config;
}

test("config picks the Aval engine only when it is asked for", () => {
  const local = loadConfig({ PHONE_STT_CMD: "whisper-cli.exe -f {wav}" });
  assert.equal(local.stt.engine, "cmd", "a configured command still means local STT");
  assert.equal(local.tts.engine, "sapi", "TTS stays local unless the operator opts in");
  assert.equal(local.aval.budgetUsdPerCall > 0, true, "a per-call spend ceiling exists by default");

  const cloud = loadConfig({ PHONE_STT_ENGINE: "aval", PHONE_TTS_ENGINE: "aval", AVAL_API_KEY: KEY });
  assert.equal(cloud.stt.engine, "aval");
  assert.equal(cloud.tts.engine, "aval");
});

test("the key is read from the environment, never invented", () => {
  const withEnv = loadConfig({ AVAL_API_KEY: "aa-env-key" });
  assert.equal(withEnv.aval.apiKey, "aa-env-key");
  const file = path.join(tmp, "phone.config.json");
  fs.writeFileSync(file, JSON.stringify({ aval: { api_key: "aa-file-key" } }));
  assert.equal(loadConfig({ PHONE_CONFIG: file }).aval.apiKey, "aa-file-key");
  fs.rmSync(file);
});

test("missing key is a clear, actionable failure for both directions", async () => {
  const config = loadConfig({ PHONE_TTS_ENGINE: "aval", PHONE_STT_ENGINE: "aval", PHONE_AUDIT_DIR: tmp });
  config.aval.apiKey = "";
  assert.equal(avalStatus(config).code, "aval-key-missing");
  const said = await speak(config, "سلام");
  assert.equal(said.ok, false);
  assert.equal(said.code, "aval-key-missing");
  const heard = await hear(config, path.join(tmp, "nope.wav"));
  assert.equal(heard.code, "aval-key-missing");
});

test("speak writes a playable WAV and prices the turn", async () => {
  const stub = await startStub();
  try {
    const config = avalConfig(stub, { PHONE_AVAL_TTS_SAMPLE_RATE: "24000" });
    const out = path.join(tmp, "spoken.wav");
    const res = await speak(config, "سلام، وقت بخیر. من دستیار دفتر مدرسه هستم.", { out });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.engine, "aval");
    assert.equal(res.model, "eleven_flash_v2_5");
    const studied = probeWav(out);
    assert.equal(studied.ok, true);
    assert.equal(studied.silent, false, "a 46-byte header would be a failure here");
    assert.ok(studied.duration > 0.2, `duration ${studied.duration}`);
    assert.equal(studied.sampleRate, config.aval.ttsSampleRate);
    // the request itself: correct model, Persian text, wav-friendly format, auth header
    const call = stub.seen.find((c) => c.url === "/audio/speech");
    const body = JSON.parse(call.body.toString("utf8"));
    assert.equal(body.model, "eleven_flash_v2_5");
    assert.equal(body.response_format, "pcm");
    assert.match(body.input, /سلام/);
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    // priced from the model's published per-second rate
    const priced = estimateUsd({ kind: "tts", pricing: { output_cost_per_second: 0.0025 }, seconds: 10 });
    assert.equal(priced, 0.025);
    assert.equal(res.usd === null || res.usd >= 0, true);
  } finally {
    await stub.close();
  }
});

test("a wav-format engine is written through unchanged", async () => {
  const stub = await startStub({ ttsType: "audio/wav" });
  try {
    const config = avalConfig(stub, { PHONE_AVAL_TTS_FORMAT: "wav" });
    const out = path.join(tmp, "spoken-wav.wav");
    const res = await speak(config, "سلام", { out });
    assert.equal(res.ok, true, res.error);
    const studied = probeWav(out);
    assert.equal(studied.silent, false);
    assert.ok(wavBytes(fs.readFileSync(out)) > 0.1);
  } finally {
    await stub.close();
  }
});

test("an unusable format is refused before any request", async () => {
  const stub = await startStub();
  try {
    const config = avalConfig(stub, { PHONE_AVAL_TTS_FORMAT: "opus" });
    const res = await speak(config, "سلام");
    assert.equal(res.ok, false);
    assert.equal(res.code, "tts-format-unsupported");
    assert.match(res.hint, /wav/);
    assert.equal(stub.seen.filter((c) => c.url === "/audio/speech").length, 0);
  } finally {
    await stub.close();
  }
});

test("mp3 without a transcoder fails loudly instead of writing junk", async () => {
  const stub = await startStub();
  try {
    const config = avalConfig(stub, { PHONE_AVAL_TTS_FORMAT: "mp3" });
    config.aval.ffmpeg = path.join(tmp, "definitely-not-ffmpeg.exe");
    const res = await speak(config, "سلام، وقت بخیر.");
    assert.equal(res.ok, false);
    assert.equal(res.code, "tts-needs-transcoder");
    assert.match(res.error, /ffmpeg/);
  } finally {
    await stub.close();
  }
});

test("mp3 with the vendored ffmpeg becomes a playable WAV", async () => {
  const ffmpeg = [
    process.env.FFMPEG_PATH,
    path.join(ROOT_DIR, "vendor", "ffmpeg", "ffmpeg.exe"),
  ].find((c) => c && fs.existsSync(c));
  const sample = fs.existsSync(path.join(ROOT_DIR, "vendor", "voice-tts"))
    ? fs.readdirSync(path.join(ROOT_DIR, "vendor", "voice-tts")).find((f) => f.endsWith(".mp3"))
    : null;
  if (!ffmpeg || !sample) {
    console.log("  - skipped: no vendored ffmpeg or no mp3 sample in vendor/voice-tts");
    return;
  }
  const mp3 = fs.readFileSync(path.join(ROOT_DIR, "vendor", "voice-tts", sample));
  const stub = await startStub({ rawPayload: mp3 });
  try {
    const config = avalConfig(stub, { PHONE_AVAL_TTS_FORMAT: "mp3" });
    config.aval.ffmpeg = ffmpeg;
    const out = path.join(tmp, "from-mp3.wav");
    const res = await speak(config, "سلام، این پیام باید به WAV تبدیل شود.", { out });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.transcoded, true);
    const studied = probeWav(out);
    assert.equal(studied.silent, false);
    assert.ok(studied.duration > 0.3, `duration ${studied.duration}`);
    assert.equal(studied.sampleRate, config.aval.wavSampleRate);
  } finally {
    await stub.close();
  }
});

test("a stub payload is a failure, never a silent turn on a live call", async () => {
  const stub = await startStub({ ttsTiny: true });
  try {
    const config = avalConfig(stub);
    const res = await speak(config, "این جمله باید صدایی تولید کند که شنیده شود.");
    assert.equal(res.ok, false);
    assert.equal(res.code, "tts-silent-output");
  } finally {
    await stub.close();
  }
});

test("empty text and over-long text are rejected before any request", async () => {
  const stub = await startStub();
  try {
    const config = avalConfig(stub, { PHONE_MAX_TEXT: "20" });
    assert.equal((await speak(config, "   ")).code, "empty-text");
    assert.equal((await speak(config, "این متن از بیست کاراکتر مشخصاً بلندتر است")).code, "text-too-long");
    assert.equal(stub.seen.filter((c) => c.url === "/audio/speech").length, 0);
  } finally {
    await stub.close();
  }
});

test("a rejected key is reported with a tier hint and without the key", async () => {
  const stub = await startStub({ ttsStatus: 401 });
  try {
    const config = avalConfig(stub);
    const res = await speak(config, "سلام");
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.match(res.hint, /tier|key/);
    assert.ok(!JSON.stringify(res).includes(KEY), "the key must never travel into the agent's view of the result");
  } finally {
    await stub.close();
  }
});

test("hear() sends the audio and returns the transcript it heard", async () => {
  const stub = await startStub({ sttText: "بله فردا ساعت نه می‌رسم" });
  try {
    const config = avalConfig(stub);
    const wav = path.join(tmp, "caller.wav");
    fs.writeFileSync(wav, encodeWav16(new Float32Array(16000).map((_, i) => Math.sin(i / 30) * 0.2), 16000));
    const res = await hear(config, wav);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.text, "بله فردا ساعت نه می‌رسم");
    assert.equal(res.empty, false);
    assert.equal(res.model, "gpt-4o-mini-transcribe");
    const call = stub.seen.find((c) => c.url === "/audio/transcriptions");
    const body = call.body.toString("latin1");
    assert.match(body, /name="language"\r?\n\r?\nfa/);
    assert.match(body, /caller\.wav/);
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  } finally {
    await stub.close();
  }
});

test("silence from the caller is reported as empty, not invented", async () => {
  const stub = await startStub({ sttText: "   " });
  try {
    const config = avalConfig(stub);
    const wav = path.join(tmp, "quiet.wav");
    fs.writeFileSync(wav, encodeWav16(new Float32Array(8000), 16000));
    const res = await hear(config, wav);
    assert.equal(res.ok, true);
    assert.equal(res.empty, true);
    assert.equal(res.text, "");
  } finally {
    await stub.close();
  }
});

test("a transcription HTTP failure is an honest error with the status", async () => {
  const stub = await startStub({ sttStatus: 404 });
  try {
    const config = avalConfig(stub);
    const wav = path.join(tmp, "missing-model.wav");
    fs.writeFileSync(wav, encodeWav16(new Float32Array(8000), 16000));
    const res = await hear(config, wav);
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.match(res.hint, /catalogue|models/);
  } finally {
    await stub.close();
  }
});

test("a connection that never answers becomes a timeout, not a fake transcript", async () => {
  const stub = await startStub({ slow: true });
  try {
    const config = avalConfig(stub);
    config.aval.sttTimeoutMs = 800;
    config.aval.timeoutMs = 800;
    const wav = path.join(tmp, "slow.wav");
    fs.writeFileSync(wav, encodeWav16(new Float32Array(8000), 16000));
    const res = await hear(config, wav);
    assert.equal(res.ok, false);
    assert.equal(res.code, "stt-timeout");
    assert.equal(res.text, "");
  } finally {
    await stub.close();
  }
});

test("a dropped connection is reported as a failure with the server's words", async () => {
  const stub = await startStub({ hang: true });
  try {
    const config = avalConfig(stub);
    config.aval.sttTimeoutMs = 4000;
    const wav = path.join(tmp, "hang.wav");
    fs.writeFileSync(wav, encodeWav16(new Float32Array(8000), 16000));
    const res = await hear(config, wav);
    assert.equal(res.ok, false);
    assert.equal(res.code, "stt-failed");
    assert.equal(res.text, "");
  } finally {
    await stub.close();
  }
});

test("the key is redacted out of every error string", () => {
  assert.equal(redactSecret(`bad request ${KEY} here`, KEY), "bad request [redacted] here");
  assert.equal(redactSecret("nothing to hide", ""), "nothing to hide");
});

test("tts/stt facades route to Aval and keep their local contract", async () => {
  const stub = await startStub();
  try {
    const config = avalConfig(stub);
    assert.equal(sttStatus(config).ok, true);
    assert.match(sttStatus(config).engine, /aval/);
    const said = await synthesize(config, "سلام، تماس آزمایشی است.");
    assert.equal(said.ok, true, said.error);
    assert.equal(said.engine, "aval");
    assert.equal(probeWav(said.path).silent, false);

    const wav = path.join(tmp, "local-route.wav");
    fs.writeFileSync(wav, encodeWav16(new Float32Array(16000).fill(0.1), 16000));
    const heard = await transcribe(config, wav);
    assert.equal(heard.ok, true);
    assert.match(heard.text, /سلام/);
  } finally {
    await stub.close();
  }
});

test("turn pricing comes from the catalogue and is cached on disk", async () => {
  const stub = await startStub();
  try {
    const config = avalConfig(stub, { PHONE_AVAL_TTS_SAMPLE_RATE: "24000" });
    config.aval.pricingCache = path.join(tmp, "pricing-cache.json");
    resetPricingCache();
    const out = path.join(tmp, "priced.wav");
    const res = await speak(config, "سلام، این جمله باید قیمت‌گذاری شود.", { out });
    assert.equal(res.ok, true, res.error);
    assert.equal(typeof res.usd, "number", "the turn is priced, not left null");
    assert.ok(res.usd > 0, `usd=${res.usd}`);
    // 0.0025 USD/s × the returned audio length
    assert.ok(Math.abs(res.usd - 0.0025 * res.seconds) < 1e-6, `${res.usd} vs ${0.0025 * res.seconds}`);
    // the cache file is what a later process (the next phone_say) reads
    const cached = JSON.parse(fs.readFileSync(config.aval.pricingCache, "utf8"));
    assert.equal(cached.models.eleven_flash_v2_5.pricing.output_cost_per_second, 0.0025);
    assert.ok(cached.expires > Date.now(), "the cached table is fresh");
  } finally {
    await stub.close();
  }

  // and the file, not the network, serves it: dead port, same cache, memory cleared
  resetPricingCache();
  const offline = avalConfig({ baseUrl: "http://127.0.0.1:9", seen: [], close: async () => {} });
  offline.aval.pricingCache = path.join(tmp, "pricing-cache.json");
  const { pricingFor } = await import("../src/local/aval.mjs");
  const price = await pricingFor(offline.aval, "eleven_flash_v2_5", "tts");
  assert.equal(price?.output_cost_per_second, 0.0025, "answered from the cached table with no reachable API");
  resetPricingCache();
});

test("an unpriceable model reports null rather than a free call", async () => {
  const stub = await startStub({ models: [{ id: "eleven_flash_v2_5", pricing: {} }] });
  try {
    const config = avalConfig(stub);
    config.aval.pricingCache = path.join(tmp, "pricing-empty.json");
    resetPricingCache();
    const res = await speak(config, "سلام.", { out: path.join(tmp, "unpriced.wav") });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.usd, null, "no published price → no invented price");
  } finally {
    await stub.close();
    resetPricingCache();
  }
});

test("the per-call voice budget stops spending mid-conversation", async () => {
  const stub = await startStub();
  try {
    const config = avalConfig(stub, { PHONE_AVAL_BUDGET_USD: "0.01" });
    resetCallCount(config);
    const deps = {
      deviceStatus: async () => ({ ok: true, state: "CONNECTED", serial: "PHONE1", model: "Pixel 7", devices: [], hint: null }),
      dial: async () => ({ ok: true, code: "in-call", state: "IN_CALL", answered: true, device: { serial: "PHONE1" } }),
      hangup: async () => ({ ok: true, code: "hung-up", state: "IDLE" }),
      callState: async () => ({ ok: true, state: "OFFHOOK" }),
      play: async () => ({ ok: true, backend: "stub", duration: 1 }),
      record: async () => ({ ok: true, path: null, duration: 1, hasSpeech: true, rms: 0.1, backend: "stub" }),
    };
    const started = await dial({ to: "09121234567", greeting: "", config, deps });
    assert.equal(started.ok, true, JSON.stringify(started));

    // the operator's cap is reached: rewrite the session as if earlier turns cost it
    const raw = JSON.parse(fs.readFileSync(config.sessionFile, "utf8"));
    raw.voice = { usd: 0.0105, tts_usd: 0.0105, stt_usd: 0, tts_calls: 3, stt_calls: 2, model: "eleven_flash_v2_5" };
    fs.writeFileSync(config.sessionFile, JSON.stringify(raw));
    assert.equal(voiceSpend(raw), 0.0105);

    const over = await say({ text: "سلام دوباره", config, deps });
    assert.equal(over.ok, false);
    assert.equal(over.code, "voice-budget-exceeded");
    assert.match(over.error, /\$0\.0105 of the \$0\.01 cap/);
    assert.equal(stub.seen.filter((c) => c.url === "/audio/speech").length, 0, "a blocked turn must not even ask the API");

    const quiet = await listen({ config, deps });
    assert.equal(quiet.code, "voice-budget-exceeded", "listening costs money too, so it is gated as well");

    await hangup({ config, deps });
  } finally {
    await stub.close();
  }
});
