// Configuration for the local SIM bridge.
//
// There are no telephony API keys anywhere in this project: the phone's own SIM
// places the call, ADB only presses the buttons, and the PC supplies the voice.
// Configuration is environment-first so an agent never needs a config file, but
// a JSON file is supported for people who prefer one (`PHONE_CONFIG`).
//
// Nothing in this module prints or returns a secret. There are none to leak.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_AUDIT_DIR = path.join(REPO_ROOT, ".tmp", "phone-bridge");
export const IS_WINDOWS = process.platform === "win32";
// bench/voice vendors a static ffmpeg build here; it makes the DirectShow audio
// backend (and the corpus tooling) work without a system-wide install.
export const VENDORED_FFMPEG = [
  path.join(REPO_ROOT, "tools", "phone-bridge", "vendor", "ffmpeg", "ffmpeg.exe"),
  path.join(REPO_ROOT, "tools", "phone-bridge", "vendor", "ffmpeg", "ffmpeg"),
].find((candidate) => fs.existsSync(candidate)) || null;

function readJsonFile(file) {
  try {
    // PowerShell 5 and Notepad add a UTF-8 BOM to JSON files; JSON.parse refuses it.
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`cannot read PHONE_CONFIG ${file}: ${error.message}`);
  }
}

/**
 * The Aval.ai key lives in one place on this machine (the provider block of the
 * OpenCode config) — the phone bridge reads the same secret instead of asking the
 * owner to paste it into a second file. Env wins; nothing here prints the key.
 */
function resolveAvalKey(env, file) {
  const fromEnv = env.AVAL_API_KEY || env.AVALAI_API_KEY;
  if (fromEnv) return String(fromEnv).trim();
  const fromConfig = String(file?.aval?.api_key || "").trim();
  if (fromConfig) return fromConfig;
  const home = env.USERPROFILE || env.HOME || "";
  if (!home) return "";
  try {
    const oc = readJsonFile(path.join(home, ".config", "opencode", "opencode.json"));
    return String(oc?.providers?.avalai?.settings?.apiKey || "").trim();
  } catch {
    return "";
  }
}

function splitList(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[,;\r\n]+/);
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function splitLines(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const file = env.PHONE_CONFIG ? readJsonFile(env.PHONE_CONFIG) : {};
  const pick = (name, fallback) => (env[name] !== undefined && env[name] !== "" ? env[name] : fallback);
  const auditDir = path.resolve(pick("PHONE_AUDIT_DIR", file.audit_dir || DEFAULT_AUDIT_DIR));

  return {
    // Simulate a call with a scripted caller; needs no phone and no audio.
    simulate: asBool(pick("PHONE_SIMULATE", file.simulate), false),
    // Force preview-only mode even when dialing is otherwise allowed.
    dryRun: asBool(pick("PHONE_DRY_RUN", file.dry_run), false),
    // Human approval for a real dial. The agent can never grant this itself.
    allowDial: asBool(pick("PHONE_ALLOW_DIAL", file.allow_dial), false),
    allowlist: splitList(pick("PHONE_ALLOWLIST", file.allowlist || [])),
    maxCallsPerRun: asNumber(pick("PHONE_MAX_CALLS", file.max_calls), 3),
    timeoutMs: asNumber(pick("PHONE_TIMEOUT_MS", file.timeout_ms), 20000),
    dialTimeoutMs: asNumber(pick("PHONE_DIAL_TIMEOUT_MS", file.dial_timeout_ms), 45000),
    answerTimeoutMs: asNumber(pick("PHONE_ANSWER_TIMEOUT_MS", file.answer_timeout_ms), 30000),
    listenSeconds: asNumber(pick("PHONE_LISTEN_SECONDS", file.listen_seconds), 8),
    maxListenSeconds: 30,
    // End-of-turn detection: record in short chunks and stop as soon as the
    // caller goes quiet, instead of always burning the full fixed window.
    listenUntilSilence: asBool(pick("PHONE_LISTEN_UNTIL_SILENCE", file.listen_until_silence), false),
    silenceMs: asNumber(pick("PHONE_SILENCE_MS", file.silence_ms), 1200),
    maxText: asNumber(pick("PHONE_MAX_TEXT", file.max_text), 1200),
    announceAi: asBool(pick("PHONE_ANNOUNCE_AI", file.announce_ai), true),
    keepAudio: asBool(pick("PHONE_KEEP_AUDIO", file.keep_audio), false),
    auditDir,
    sessionFile: path.join(auditDir, "session.json"),
    script: splitLines(pick("PHONE_SCRIPT", file.script || "")),

    adb: {
      path: pick("ADB_PATH", file.adb?.path || (IS_WINDOWS ? "adb.exe" : "adb")),
      serial: pick("ADB_DEVICE_SERIAL", file.adb?.serial || ""),
      // "192.168.1.50:5555" enables wireless debugging.
      wireless: pick("ADB_WIRELESS", file.adb?.wireless || ""),
      timeoutMs: asNumber(pick("ADB_TIMEOUT_MS", file.adb?.timeout_ms), 15000),
    },

    audio: {
      // auto: ffmpeg when installed, otherwise Windows MCI, otherwise none.
      backend: String(pick("PHONE_AUDIO_BACKEND", file.audio?.backend || "auto")).toLowerCase(),
      // Device name fragments. Only used by the ffmpeg backend (DirectShow).
      inputDevice: pick("PHONE_AUDIO_INPUT", file.audio?.input || ""),
      outputDevice: pick("PHONE_AUDIO_OUTPUT", file.audio?.output || ""),
      ffmpeg: pick("FFMPEG_PATH", file.audio?.ffmpeg || VENDORED_FFMPEG || "ffmpeg"),
      sampleRate: asNumber(pick("PHONE_SAMPLE_RATE", file.audio?.sample_rate), 16000),
      minRms: asNumber(pick("PHONE_MIN_RMS", file.audio?.min_rms), 0.004),
      // Optional playback hook, e.g. `myplayer.exe {wav}`. {wav} is the path.
      playCmd: pick("PHONE_PLAY_CMD", file.audio?.play_cmd || ""),
    },

    tts: {
      // sapi:  Windows built-in voices (no install, no network).
      // cmd:   any local engine through PHONE_TTS_CMD (Piper, eSpeak-NG, ...).
      // aval:  Persian voice through the Aval.ai API (see src/local/aval.mjs).
      engine: String(pick("PHONE_TTS_ENGINE", file.tts?.engine || "sapi")).toLowerCase(),
      voice: pick("PHONE_TTS_VOICE", file.tts?.voice || ""),
      rate: asNumber(pick("PHONE_TTS_RATE", file.tts?.rate), 0),
      command: pick("PHONE_TTS_CMD", file.tts?.command || ""),
    },

    stt: {
      // cmd:  any local engine through PHONE_STT_CMD ({wav} → transcript on stdout).
      // aval: Persian speech-to-text through the Aval.ai API.
      engine: String(pick("PHONE_STT_ENGINE", file.stt?.engine || (pick("PHONE_STT_CMD", file.stt?.command || "") ? "cmd" : "none"))).toLowerCase(),
      command: pick("PHONE_STT_CMD", file.stt?.command || ""),
      language: pick("PHONE_STT_LANGUAGE", file.stt?.language || "fa"),
      timeoutMs: asNumber(pick("PHONE_STT_TIMEOUT_MS", file.stt?.timeout_ms), 120000),
    },

    // Cloud voice on the Aval.ai API. Chosen by bench/voice (real recorded
    // Persian, both 16 kHz and 8 kHz telephone band). This buys audio, not
    // telephony: the SIM still dials, the gates still gate.
    aval: {
      baseUrl: pick("AVAL_BASE_URL", file.aval?.base_url || "https://api.avalai.ir/v1"),
      apiKey: resolveAvalKey(env, file),
      ttsModel: pick("PHONE_AVAL_TTS_MODEL", file.aval?.tts_model || ""),
      ttsVoice: pick("PHONE_AVAL_TTS_VOICE", file.aval?.tts_voice || ""),
      ttsFormat: String(pick("PHONE_AVAL_TTS_FORMAT", file.aval?.tts_format) || "pcm").toLowerCase(),
      ttsSampleRate: asNumber(pick("PHONE_AVAL_TTS_SAMPLE_RATE", file.aval?.tts_sample_rate), 44100),
      ttsSpeed: asNumber(pick("PHONE_AVAL_TTS_SPEED", file.aval?.tts_speed), 1),
      ttsPersian: asBool(pick("PHONE_AVAL_TTS_PERSIAN", file.aval?.tts_persian), true),
      sttModel: pick("PHONE_AVAL_STT_MODEL", file.aval?.stt_model || ""),
      sttLanguage: pick("PHONE_AVAL_STT_LANGUAGE", file.aval?.stt_language || "fa"),
      sttPrompt: pick("PHONE_AVAL_STT_PROMPT", file.aval?.stt_prompt || ""),
      // mp3 voices (ElevenLabs through Aval) are decoded with ffmpeg during the call.
      ffmpeg: pick("PHONE_AVAL_FFMPEG", file.aval?.ffmpeg || pick("FFMPEG_PATH", file.audio?.ffmpeg || "") || VENDORED_FFMPEG || "ffmpeg"),
      wavSampleRate: asNumber(pick("PHONE_AVAL_WAV_RATE", file.aval?.wav_sample_rate), 16000),
      sttTimeoutMs: asNumber(pick("PHONE_AVAL_STT_TIMEOUT_MS", file.aval?.stt_timeout_ms), 30000),
      timeoutMs: asNumber(pick("PHONE_AVAL_TIMEOUT_MS", file.aval?.timeout_ms), 30000),
      // Hard ceiling on voice spend for one call; 0 disables the guard.
      // $0.15 covers roughly two minutes on the pinned pair (eleven_v4_turbo speaks
      // ~$0.0007/s, scribe_v2 listens ~$0.000062/s) — see bench/voice/VOICE-RESULTS.md.
      budgetUsdPerCall: asNumber(pick("PHONE_AVAL_BUDGET_USD", file.aval?.budget_usd_per_call), 0.15),
      // Where the /models price table is cached, so per-turn pricing does not
      // refetch 365 models on every phone_say.
      pricingCache: path.resolve(pick("PHONE_AVAL_PRICING_CACHE", file.aval?.pricing_cache || path.join(auditDir, "aval-pricing.json"))),
      fetchImpl: globalThis.fetch,
    },

    // The brain for phone sessions. The voice path is local; only the ReAct
    // model is remote, and this pins the cheapest one that passes
    // tools/phone-bridge/bench (see bench/RESULTS.md). The Vanilla adapter
    // reads it; the bridge itself never calls a model.
    agent: {
      model: String(pick("PHONE_AGENT_MODEL", file.agent?.model || "")).trim(),
    },
  };
}

/** True when a real dial is permitted by every configured gate. */
export function dialGates(config) {
  const problems = [];
  if (config.dryRun) problems.push({ code: "dry-run", message: "PHONE_DRY_RUN=1: preview only" });
  if (!config.allowDial) {
    problems.push({
      code: "dial-not-approved",
      message: "real dialing is not approved: set PHONE_ALLOW_DIAL=1 (or pass --allow-dial) once the phone and audio route are known good",
    });
  }
  return problems;
}
