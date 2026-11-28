// Thin Aval.ai audio client used by the voice benchmark.
//
// Everything here is honest about failure: a non-200 is returned as {ok:false}
// with the server's own message, never as an empty-but-successful result. A
// transcription that comes back empty is reported as `empty: true` so a grader
// can tell "the model heard nothing" apart from "the model transcribed nothing".
//
// The key is read from the environment (AVAL_API_KEY / OPENAI_API_KEY) or from
// the phone config file; it is never printed, never stored in results, and
// never written to disk by this module.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BASE = "https://api.avalai.ir/v1";

function readJsonSafe(file) {
  try {
    // Windows editors (PowerShell 5, Notepad) love a UTF-8 BOM; JSON.parse does not.
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

export function resolveKey(env = process.env, configFile = null) {
  const fromEnv = env.AVAL_API_KEY || env.AVALAI_API_KEY || env.OPENAI_API_KEY;
  if (fromEnv) return String(fromEnv).trim();
  const file = configFile || env.PHONE_CONFIG || path.join(process.cwd(), "phone.config.json");
  const json = readJsonSafe(file);
  const key = json?.aval?.api_key || json?.agent?.api_key || "";
  if (key) return String(key).trim();
  const oc = path.join(env.USERPROFILE || env.HOME || "", ".config", "opencode", "opencode.json");
  return String(readJsonSafe(oc)?.providers?.avalai?.settings?.apiKey || "").trim();
}

export function redact(text, key) {
  if (!key) return String(text ?? "");
  return String(text ?? "").split(key).join("***");
}

export class AvalVoice {
  constructor({ base = DEFAULT_BASE, key, timeoutMs = 60000, fetchImpl = globalThis.fetch } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.key = String(key || "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.calls = [];
  }

  async #run(label, url, init) {
    if (!this.key) return { ok: false, status: 0, error: "no api key: set AVAL_API_KEY", ms: 0 };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(url, { ...init, signal: controller.signal, headers: { ...(init.headers || {}), Authorization: `Bearer ${this.key}` } });
      const ms = Date.now() - started;
      const ctype = res.headers.get("content-type") || "";
      if (ctype.includes("json")) {
        const text = redact(await res.text(), this.key);
        if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 700), ms };
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
        this.calls.push({ label, ms, status: res.status });
        return { ok: true, status: res.status, json: data, ms };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) return { ok: false, status: res.status, error: redact(new TextDecoder().decode(bytes), this.key).slice(0, 700), ms };
      this.calls.push({ label, ms, status: res.status, bytes: bytes.byteLength });
      return { ok: true, status: res.status, bytes, contentType: ctype, ms };
    } catch (error) {
      const aborted = String(error?.name || "") === "AbortError" || String(error?.cause?.name || "") === "AbortError";
      return { ok: false, status: 0, error: redact(aborted ? `timeout after ${this.timeoutMs}ms` : error?.message || error, this.key), ms: Date.now() - started, timedOut: aborted };
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /audio/speech → raw audio bytes (mp3/wav/pcm depend on `format`). */
  async speech({ model, input, voice, format = "mp3", speed = 1, temperature, ...rest }) {
    const body = { model, input, voice, response_format: format, ...rest };
    if (speed !== undefined && speed !== null) body.speed = speed;
    if (temperature !== undefined && temperature !== null) body.temperature = temperature;
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    return this.#run("speech", `${this.base}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** POST /audio/transcriptions → text. `file` is a Uint8Array or {name,bytes}. */
  async transcribe({ model, file, filename = "audio.mp3", language, prompt, temperature, ...rest }) {
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([file]), filename);
    if (language) form.append("language", language);
    if (prompt) form.append("prompt", String(prompt).slice(0, 224));
    if (temperature !== undefined) form.append("temperature", String(temperature));
    form.append("response_format", "json");
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) form.append(k, String(v));
    const res = await this.#run("transcriptions", `${this.base}/audio/transcriptions`, { method: "POST", body: form });
    if (!res.ok) return res;
    const text = String(res.json?.text ?? "");
    return { ...res, text, empty: !text.trim() };
  }

  /** POST /chat/completions with audio output (speech-to-speech probe). */
  async chatAudio({ model, messages, voice = "alloy", format = "wav", maxTokens = 512, tools, temperature }) {
    const body = {
      model,
      messages,
      modalities: ["audio", "text"],
      audio: { voice, format },
      max_tokens: maxTokens,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };
    const res = await this.#run("chat-audio", `${this.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    const choice = res.json?.choices?.[0]?.message;
    return { ...res, text: choice?.content || choice?.audio?.transcript || "", audioTranscript: choice?.audio?.transcript || "", audioB64: choice?.audio?.data || "", usage: res.json?.usage || null };
  }

  /** GET /models → full catalog with pricing + capability flags. */
  async models() {
    const res = await this.#run("models", `${this.base}/models`, { method: "GET" });
    return res.ok ? res.json?.data || [] : res;
  }
}

/**
 * Aval rate-limits by account tier (3–100 requests/minute on audio models), so a
 * benchmark run must back off instead of recording 429s as model failures.
 */
export async function retry(fn, { tries = 4, baseMs = 4000, log = () => {} } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await fn();
    if (last.ok) return last;
    const throttled = last.status === 429 || /rate.?limit|too many/i.test(String(last.error || ""));
    const transient = last.timedOut || last.status === 0 || last.status >= 500;
    if (!throttled && !transient) return last;
    const wait = baseMs * (i + 1) * (throttled ? 3 : 1);
    log(`${throttled ? "rate-limited" : "transient"} → waiting ${Math.round(wait / 1000)}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return last;
}

/** Estimates for a call, mirroring how the bridge will be used. USD/minute. */
export function priceFor(entry, { kind }) {
  const p = entry?.pricing || {};
  if (kind === "stt" && p.input_cost_per_second) return { unit: "second", usd_per_unit: p.input_cost_per_second };
  if (kind === "tts" && p.output_cost_per_second) return { unit: "second", usd_per_unit: p.output_cost_per_second };
  if (kind === "tts" && p.input_cost_per_character) return { unit: "character", usd_per_unit: p.input_cost_per_character };
  return null;
}
