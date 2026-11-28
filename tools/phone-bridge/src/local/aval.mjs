// Persian voice over the Aval.ai API — the cloud counterpart of local SAPI/Piper.
//
// Why this file exists: the local path could not prove Persian speech (no fa
// Windows voice, Piper binary too old, whisper not downloaded). Aval.ai exposes
// speech models directly — OpenAI TTS, ElevenLabs, Gemini TTS on
// POST /audio/speech, and Whisper/GPT-4o/Scribe on POST /audio/transcriptions —
// so the call hears and speaks Persian through one API the owner already pays
// for. Which model won is recorded in bench/voice/VOICE-RESULTS.md.
//
// Kept deliberately honest:
//   * No secret ever leaves this module: the key is only put in a header, and
//     error text is redacted before it reaches an audit log.
//   * A refusal, timeout or empty body is an error, never a silent "" success.
//   * Every turn reports its price (from the model's own published rate) so the
//     caller-level budget gate in index.mjs can stop a runaway call.
//   * `wav` and `pcm` need no tools. `mp3` — the only format ElevenLabs returns
//     through this proxy (wav/pcm answer 503) — is decoded with the vendored
//     ffmpeg, and refused with `tts-needs-transcoder` when that binary is absent,
//     so a call never dies on a format it cannot play.
//
// The phone number, the SIM and the dialling gates are untouched: Aval carries
// voice, the phone still carries the call.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cleanText, looksPersian } from "./tts.mjs";
import { cleanTranscript } from "./stt.mjs";

const HEADER = 44;

/** 16-bit PCM samples → a mono WAV buffer. No external tools involved. */
export function pcm16ToWav(pcm, sampleRate = 24000) {
  const data = Buffer.from(pcm);
  const out = Buffer.alloc(HEADER + data.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + data.length, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(data.length, 40);
  data.copy(out, HEADER);
  return out;
}

export function wavBytes(buffer) {
  try {
    const byteRate = buffer.readUInt32LE(28);
    let offset = 12;
    let dataLen = Math.max(0, buffer.length - HEADER);
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === "data") dataLen = size;
      offset += 8 + size + (size % 2);
    }
    return byteRate ? dataLen / byteRate : 0;
  } catch {
    return 0;
  }
}

/** Seconds billed per $ from the model's published price table. */
export function priceOf(pricing = {}, kind) {
  if (kind === "stt" && pricing.input_cost_per_second) return { unit: "second", rate: pricing.input_cost_per_second };
  if (kind === "tts" && pricing.output_cost_per_second) return { unit: "second", rate: pricing.output_cost_per_second };
  if (kind === "tts" && pricing.input_cost_per_character) return { unit: "character", rate: pricing.input_cost_per_character };
  return null;
}

export function estimateUsd({ kind, pricing, characters = 0, seconds = 0 }) {
  const p = priceOf(pricing || {}, kind);
  if (!p) return null;
  const value = p.unit === "character" ? characters : seconds;
  return Number((p.rate * value).toFixed(6));
}

const PRICING_TTL_MS = 1000 * 60 * 60 * 24 * 30;
let memoryPricing = null;

/** Test hook: forget the in-memory catalogue copy. */
export function resetPricingCache() {
  memoryPricing = null;
}

/**
 * The published price of a model, needed to bill a turn.
 *
 * A call runs as one CLI process per tool, so an in-memory map alone would refetch
 * the whole catalogue on every turn: the table is also cached in a small JSON file
 * under the audit directory. `aval.tts_pricing` / `aval.stt_pricing` in the config
 * override everything (offline use, tests). When nothing is available the turn is
 * priced as null, and the budget gate says "unpriced" instead of pretending the
 * call was free.
 */
export async function pricingFor(aval, model, kind) {
  const direct = kind === "tts" ? aval.ttsPricing : aval.sttPricing;
  if (direct && Object.keys(direct).length) return direct;
  if (!model) return null;
  if (memoryPricing?.table && Date.now() - memoryPricing.at < PRICING_TTL_MS) return memoryPricing.table?.[model]?.pricing || null;

  const file = aval.pricingCache || null;
  if (file) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cached?.expires > Date.now()) {
        memoryPricing = { table: cached.models, at: cached.expires - PRICING_TTL_MS };
        return cached.models?.[model]?.pricing || null;
      }
    } catch {
      // no usable cache yet
    }
  }
  if (!aval.apiKey) return null;
  const res = await request(aval, "models", { method: "GET", timeoutMs: Math.min(15000, aval.timeoutMs || 15000) });
  const list = res.ok ? res.json?.data || [] : [];
  if (!list.length) return null;
  const table = {};
  for (const m of list) if (m?.id) table[m.id] = { pricing: m.pricing || {}, mode: m.mode || null };
  memoryPricing = { table, at: Date.now() };
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetched: new Date().toISOString(), expires: Date.now() + PRICING_TTL_MS, models: table }));
    } catch {
      // a cache write must never break a call
    }
  }
  return table[model]?.pricing || null;
}

export function avalStatus(config) {
  const aval = config.aval || {};
  if (!aval.apiKey) {
    return {
      ok: false,
      configured: false,
      code: "aval-key-missing",
      hint: "set AVAL_API_KEY (or aval.api_key in PHONE_CONFIG). The key is used only for /audio/* and never logged.",
    };
  }
  return { ok: true, configured: true, baseUrl: aval.baseUrl, budgetUsdPerCall: aval.budgetUsdPerCall || 0 };
}

async function request(aval, endpoint, { method = "POST", json, form, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await aval.fetchImpl(`${aval.baseUrl.replace(/\/+$/, "")}/${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${aval.apiKey}`, ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : form,
      signal: controller.signal,
    });
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("json")) {
      const text = redactSecret(await res.text(), aval.apiKey);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { ok: res.ok, status: res.status, json: parsed, text, ctype };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, bytes, ctype: redactSecret(ctype, aval.apiKey), text: res.ok ? "" : redactSecret(bytes.toString("utf8", 0, 400), aval.apiKey) };
  } catch (error) {
    const timedOut = String(error?.name || "") === "AbortError" || String(error?.cause?.name || "") === "AbortError";
    return { ok: false, status: 0, error: redactSecret(timedOut ? `timeout after ${timeoutMs}ms` : error?.message || error, aval.apiKey), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip the key from anything that may be written to an audit log. */
export function redactSecret(text, key) {
  const s = String(text ?? "");
  return key ? s.split(key).join("[redacted]") : s;
}

/**
 * Formats that can be written during a call:
 *   wav  — self-describing, written straight through
 *   pcm  — headerless 16-bit mono, wrapped in pure JavaScript
 *   mp3  — what ElevenLabs through Aval actually returns; needs the vendored
 *          ffmpeg, so it is only accepted when that binary is reachable
 */
const FORMATS = ["pcm", "wav", "mp3"];

function runTranscode(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stderr: err || `transcode timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: String(error?.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr: err });
    });
  });
}

/** Decode the engine's audio into the WAV the playback and STT paths expect. */
async function writeAudio(aval, payload, target, format) {
  if (format === "wav") {
    fs.writeFileSync(target, payload);
    return { ok: true };
  }
  if (format === "mp3") {
    const bin = aval.ffmpeg || "ffmpeg";
    const needsPath = /[\\/]/.test(bin) && !fs.existsSync(bin);
    if (needsPath) {
      return { ok: false, code: "tts-needs-transcoder", error: `mp3 arrived but the configured ffmpeg is missing: ${bin}`, hint: "point FFMPEG_PATH at vendor\\ffmpeg\\ffmpeg.exe, or use PHONE_AVAL_TTS_FORMAT=wav/pcm" };
    }
    const source = `${target}.mp3`;
    fs.writeFileSync(source, payload);
    const res = await runTranscode(bin, ["-y", "-loglevel", "error", "-i", source, "-ac", "1", "-ar", String(aval.wavSampleRate || 16000), target], Math.min(60000, aval.timeoutMs || 30000));
    try {
      fs.unlinkSync(source);
    } catch {
      // best effort
    }
    if (!res.ok || !fs.existsSync(target)) {
      return { ok: false, code: "tts-needs-transcoder", error: `ffmpeg could not decode the returned mp3: ${String(res.stderr).slice(0, 200) || "no output"}`, hint: "check FFMPEG_PATH, or choose a voice that returns wav/pcm" };
    }
    return { ok: true, transcoded: true };
  }
  fs.writeFileSync(target, pcm16ToWav(payload, aval.ttsSampleRate || 24000));
  return { ok: true };
}

/**
 * Speak `text` with the configured Aval voice.
 * @returns {{ok:boolean, path?:string, engine?:string, model?:string, seconds?:number, usd?:number|null, error?:string}}
 */
export async function speak(config, text, { out } = {}) {
  const aval = config.aval || {};
  const status = avalStatus(config);
  if (!status.ok) return { ok: false, code: status.code, error: "Aval.ai is not configured", hint: status.hint };
  if (!aval.ttsModel) return { ok: false, code: "tts-not-configured", error: "PHONE_AVAL_TTS_MODEL is empty", hint: "set PHONE_AVAL_TTS_MODEL, e.g. eleven_flash_v2_5" };

  const spoken = cleanText(text);
  if (!spoken) return { ok: false, code: "empty-text", error: "nothing to say: text is empty" };
  if (spoken.length > config.maxText) return { ok: false, code: "text-too-long", error: `text too long (${spoken.length} > ${config.maxText})` };

  const format = String(aval.ttsFormat || "pcm").toLowerCase();
  if (!FORMATS.includes(format)) {
    return { ok: false, code: "tts-format-unsupported", error: `aval TTS format "${format}" is not one of ${FORMATS.join("/")}`, hint: "use PHONE_AVAL_TTS_FORMAT=wav (no tools needed), pcm, or mp3 (needs ffmpeg)" };
  }

  const target = out || path.join(config.auditDir, "tts", `${Date.now()}.wav`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const started = Date.now();
  const res = await request(aval, "audio/speech", {
    timeoutMs: aval.timeoutMs,
    json: {
      model: aval.ttsModel,
      input: spoken,
      voice: aval.ttsVoice || undefined,
      response_format: format,
      ...(aval.ttsSpeed && aval.ttsSpeed !== 1 ? { speed: aval.ttsSpeed } : {}),
      ...(aval.ttsStability !== undefined ? { stability: aval.ttsStability } : {}),
    },
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    return {
      ok: false,
      code: res.timedOut ? "tts-timeout" : "tts-failed",
      error: String(res.error || res.text || `HTTP ${res.status}`).slice(0, 500),
      status: res.status,
      ms,
      hint: res.status === 401 || res.status === 403 ? "the Aval key was rejected or the model needs a higher tier" : res.status === 429 ? "rate limited: slow the call down or lower PHONE_MAX_CALLS" : res.status === 503 ? "the voice upstream is overloaded or the format is not served — try response_format=mp3 for ElevenLabs, or wav for Gemini" : null,
    };
  }
  const payload = res.bytes || Buffer.alloc(0);
  if (payload.length < 1000) {
    return { ok: false, code: "tts-silent-output", error: `the voice returned ${payload.length} bytes for ${spoken.length} characters`, ms, hint: "check PHONE_AVAL_TTS_MODEL/VOICE; a voice that cannot pronounce Persian returns a stub" };
  }

  const decoded = await writeAudio(aval, payload, target, format);
  if (!decoded.ok) return { ...decoded, ms };
  const seconds = wavBytes(fs.readFileSync(target));
  if (!seconds || seconds <= 0.05) {
    try {
      fs.unlinkSync(target);
    } catch {
      // best effort
    }
    return { ok: false, code: "tts-silent-output", error: "decoded audio has no samples", ms };
  }
  const usd = estimateUsd({ kind: "tts", pricing: await pricingFor(aval, aval.ttsModel, "tts"), characters: spoken.length, seconds });
  const warning = looksPersian(spoken) && !aval.ttsPersian
    ? "PHONE_AVAL_TTS_PERSIAN is off: the configured voice may not be a Persian-capable one"
    : null;
  return {
    ok: true,
    path: target,
    engine: "aval",
    model: aval.ttsModel,
    voice: aval.ttsVoice || "default",
    culture: "fa-IR",
    format,
    transcoded: Boolean(decoded.transcoded),
    seconds,
    duration: seconds,
    usd,
    ms,
    warning,
  };
}

/**
 * Transcribe a WAV the caller left on the line.
 * @returns {{ok:boolean, text:string, usd?:number|null, empty?:boolean, error?:string}}
 */
export async function hear(config, wavPath) {
  const aval = config.aval || {};
  const status = avalStatus(config);
  if (!status.ok) return { ok: false, text: "", code: status.code, error: "Aval.ai is not configured", hint: status.hint };
  if (!aval.sttModel) return { ok: false, text: "", code: "stt-not-configured", error: "PHONE_AVAL_STT_MODEL is empty", hint: "set PHONE_AVAL_STT_MODEL, e.g. gpt-4o-mini-transcribe" };
  if (!wavPath || !fs.existsSync(wavPath)) return { ok: false, text: "", code: "missing-audio", error: `audio file not found: ${wavPath}` };

  const file = fs.readFileSync(wavPath);
  const seconds = wavBytes(file);
  const form = new FormData();
  form.append("model", aval.sttModel);
  form.append("file", new Blob([file], { type: "audio/wav" }), path.basename(wavPath));
  if (aval.sttLanguage) form.append("language", aval.sttLanguage);
  if (aval.sttPrompt) form.append("prompt", String(aval.sttPrompt).slice(0, 224));
  form.append("response_format", "json");

  const started = Date.now();
  const res = await request(aval, "audio/transcriptions", { timeoutMs: aval.sttTimeoutMs || aval.timeoutMs, form });
  const ms = Date.now() - started;

  if (!res.ok) {
    return {
      ok: false,
      text: "",
      code: res.timedOut ? "stt-timeout" : "stt-failed",
      error: String(res.error || res.text || `HTTP ${res.status}`).slice(0, 500),
      status: res.status,
      ms,
      hint: res.status === 404 ? "the Aval catalogue has no such transcription model (check GET /models)" : null,
    };
  }
  const text = cleanTranscript(res.json?.text ?? res.json?.transcript ?? "");
  if (res.ok && !text) {
    // A real API answer of "nothing heard" is legitimate: report it as empty.
    return { ok: true, text: "", empty: true, engine: "aval", model: aval.sttModel, usd: estimateUsd({ kind: "stt", pricing: await pricingFor(aval, aval.sttModel, "stt"), seconds }), ms };
  }
  return { ok: true, text, empty: false, engine: "aval", model: aval.sttModel, usd: estimateUsd({ kind: "stt", pricing: await pricingFor(aval, aval.sttModel, "stt"), seconds }), ms };
}
