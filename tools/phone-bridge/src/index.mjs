// Local SIM phone bridge — the API the secretary agent uses.
//
// Mental model:
//   phone_dial    → ADB presses "call" on your Android phone; the SIM connects.
//   phone_say     → local TTS → PC audio out → phone mic (Bluetooth HFP / cable).
//   phone_listen  → phone audio out → PC audio in → local STT → text.
//   phone_hangup  → ADB ends the call.
//
// No telephony provider, no API key, no per-minute fee. The carrier is the
// SIM in the phone. Every function returns data instead of throwing so the
// ReAct loop can read the failure and adapt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialGates, loadConfig } from "./config.mjs";
import { normalizeIranNumber } from "./numbers.mjs";
import { appendCallRecord, clearSession, readCallRecords, saveCallTranscript } from "./store.mjs";
import { trailingSilenceMs, concatWavFiles } from "./local/wav.mjs";
import * as adb from "./local/adb.mjs";
import * as audio from "./local/audio.mjs";
import * as tts from "./local/tts.mjs";
import * as stt from "./local/stt.mjs";
import {
  addTurn,
  createSession,
  durationSeconds,
  loadSession,
  newSessionId,
  persist,
  resetCallCount,
  transcriptText,
} from "./session.mjs";

export { resetCallCount };

function resolveDeps(overrides = {}) {
  return {
    deviceStatus: adb.deviceStatus,
    dial: adb.dial,
    hangup: adb.hangup,
    callState: adb.getCallState,
    telemetry: adb.telemetry,
    synthesize: tts.synthesize,
    play: audio.play,
    record: audio.record,
    transcribe: stt.transcribe,
    listVoices: tts.listVoices,
    listAudio: audio.listAudioEndpoints,
    audioBackend: audio.audioBackend,
    ...overrides,
  };
}

function audit(config, record) {
  try {
    appendCallRecord(config, record);
  } catch {
    // An audit failure must never hide the real result.
  }
}

function destinationAllowed(allowlist, number) {
  return allowlist.some((entry) => {
    const normalized = normalizeIranNumber(entry);
    if (normalized.ok) return normalized.national === number.national;
    return String(entry).trim() === number.national || String(entry).trim() === number.e164;
  });
}

function recentDialCount(config, windowMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  return readCallRecords(config, 5000).filter(
    (record) =>
      record.event === "dial" &&
      record.ok &&
      !record.simulated &&
      !record.dryRun &&
      Date.parse(record.at || 0) >= cutoff,
  ).length;
}

function numberInfo(number) {
  return { national: number.national, e164: number.e164, kind: number.kind };
}

function sessionInfo(session) {
  return {
    id: session.id,
    state: session.state,
    simulated: session.simulated,
    to: session.number,
    startedAt: session.startedAt,
    durationSeconds: durationSeconds(session),
    turns: session.turns.length,
    lastTurn: session.turns[session.turns.length - 1] ?? null,
    warnings: session.warnings ?? [],
  };
}

async function closeSession(config, session, { reason, live = null } = {}) {
  session.state = "IDLE";
  session.endedAt = new Date().toISOString();
  session.endReason = reason || null;
  let archive = null;
  try {
    archive = saveCallTranscript(config, session);
  } catch {
    // best effort
  }
  clearSession(config);
  return { archive, live };
}

/**
 * Cloud voice is billed per turn, so a runaway conversation is a real cost.
 * The session keeps its voice spend and both voice entry points refuse to spend
 * past PHONE_AVAL_BUDGET_USD. Local engines always report usd:null and are never
 * blocked by this.
 */
export function voiceSpend(session) {
  return Number(session?.voice?.usd ?? 0);
}

function budgetBlock(config, session) {
  const cap = Number(config.aval?.budgetUsdPerCall) || 0;
  if (!cap) return null;
  const spent = voiceSpend(session);
  if (spent < cap) return null;
  return {
    ok: false,
    code: "voice-budget-exceeded",
    error: `cloud voice already cost $${spent.toFixed(4)} of the $${cap} cap for this call`,
    hint: "say goodbye with phone_say (it will be refused too), then phone_hangup; raise PHONE_AVAL_BUDGET_USD only on purpose",
    spent: Number(spent.toFixed(6)),
    cap,
  };
}

function recordVoiceCost(session, kind, result) {
  const usd = Number(result?.usd ?? 0);
  if (!Number.isFinite(usd) || usd <= 0) return;
  const voice = session.voice || { usd: 0, tts_usd: 0, stt_usd: 0, tts_calls: 0, stt_calls: 0 };
  voice.usd = Number((voice.usd + usd).toFixed(6));
  if (kind === "tts") {
    voice.tts_usd = Number((voice.tts_usd + usd).toFixed(6));
    voice.tts_calls += 1;
  } else {
    voice.stt_usd = Number((voice.stt_usd + usd).toFixed(6));
    voice.stt_calls += 1;
  }
  voice.model = result.model ?? voice.model ?? null;
  session.voice = voice;
}

async function speakIntoCall(config, session, text, deps) {
  const clean = tts.cleanText(text);
  if (!clean) return { ok: false, code: "empty-text", error: "nothing to say: text is empty" };
  if (clean.length > config.maxText) {
    return { ok: false, code: "text-too-long", error: `text too long (${clean.length} > ${config.maxText}); split it into sentences` };
  }

  if (session.simulated) {
    addTurn(session, "agent", clean);
    persist(config, session);
    return { ok: true, simulated: true, chars: clean.length, text: clean };
  }

  const blocked = budgetBlock(config, session);
  if (blocked) {
    session.warnings = [...(session.warnings ?? []), blocked.error];
    persist(config, session);
    audit(config, { event: "say", id: session.id, to: session.number.national, ok: false, code: blocked.code, spent: blocked.spent });
    return blocked;
  }

  const synth = await deps.synthesize(config, clean);
  if (!synth.ok) {
    const warning = synth.error || "text-to-speech failed";
    session.warnings = [...(session.warnings ?? []), warning];
    persist(config, session);
    return { ok: false, code: synth.code || "tts-failed", error: warning, hint: synth.hint, available: synth.available };
  }
  recordVoiceCost(session, "tts", synth);

  const played = await deps.play(config, synth.path);
  if (!config.keepAudio) {
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(synth.path)) fs.unlinkSync(synth.path);
    } catch {
      // best effort
    }
  }

  if (!played.ok) {
    const warning = played.error || "audio playback failed";
    session.warnings = [...(session.warnings ?? []), warning];
    persist(config, session);
    return { ok: false, code: played.code || "playback-failed", error: warning, hint: "check the Windows default playback device and the phone audio route" };
  }

  addTurn(session, "agent", clean);
  persist(config, session);
  return {
    ok: true,
    chars: clean.length,
    text: clean,
    engine: synth.engine,
    voice: synth.voice,
    culture: synth.culture,
    warning: synth.warning || null,
    duration: synth.duration ?? played.duration ?? null,
    usd: synth.usd ?? null,
    voice_usd_total: voiceSpend(session),
  };
}

async function finalizeIfEnded(config, session, deps) {
  const live = await deps.callState(config);
  if (live.ok && live.state === "IDLE") {
    const closed = await closeSession(config, session, { reason: "ended-on-phone", live });
    audit(config, { event: "hangup", id: session.id, to: session.number.national, ok: true, reason: "ended-on-phone", turns: session.turns.length, archive: closed.archive });
    return { ended: true, live };
  }
  return { ended: false, live };
}

/**
 * Start an outbound call.
 *
 * @param {object} options
 * @param {string} options.to            Iranian number in any common format
 * @param {string} [options.greeting]    words to speak once the call connects
 * @param {boolean} [options.dryRun]     validate and log without dialing
 * @param {boolean} [options.allowDial]  one-shot approval for a real call
 * @param {object} [options.config]      result of loadConfig()
 * @param {object} [options.deps]        injectable ADB/TTS/audio functions (tests)
 */
export async function dial(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const number = normalizeIranNumber(options.to);
  const greeting = String(options.greeting ?? options.text ?? "").trim();
  const dryRun = Boolean(options.dryRun) || config.dryRun;
  const simulated = !dryRun && (options.simulate === true || config.simulate);
  const allowDial = options.allowDial === true || config.allowDial;

  const base = {
    dryRun,
    simulated,
    to: number.ok ? numberInfo(number) : { input: options.to },
  };

  if (!number.ok) return { ...base, ok: false, code: "invalid-number", error: `invalid destination: ${number.reason}` };
  if (greeting.length > config.maxText) {
    return { ...base, ok: false, code: "text-too-long", error: `greeting too long (${greeting.length} > ${config.maxText})` };
  }

  const active = loadSession(config);
  if (active) {
    return {
      ...base,
      ok: false,
      blocked: true,
      code: "call-in-progress",
      error: `a call session is already active (${active.id}, ${active.state})`,
      hint: "finish it with phone_hangup or inspect it with phone_status before dialing again",
    };
  }

  if (dryRun) {
    const preview = {
      ok: true,
      ...base,
      code: "dry-run",
      state: "PREVIEW",
      preview: { to: numberInfo(number), greeting: greeting || null, announceAi: config.announceAi },
      hint: "nothing was dialed; set PHONE_ALLOW_DIAL=1 (and omit dry_run) for a real call",
    };
    audit(config, { event: "dial", id: null, to: number.national, ok: true, dryRun: true, simulated: false, greeting: greeting || null });
    return preview;
  }

  if (simulated) {
    const session = createSession({
      id: newSessionId("sim"),
      number,
      simulated: true,
      script: config.script,
    });
    if (config.announceAi) addTurn(session, "system", "AI disclosure enabled: the assistant identifies itself as automated.", { note: true });
    persist(config, session);

    let greetingResult = null;
    if (greeting) greetingResult = await speakIntoCall(config, session, greeting, deps);

    audit(config, { event: "dial", id: session.id, to: number.national, ok: true, simulated: true, greeting: greeting || null });
    return {
      ok: true,
      ...base,
      code: "simulated-call",
      id: session.id,
      state: "SIMULATED",
      answered: true,
      greeting: greetingResult,
      scriptedTurns: config.script.length,
      hint: config.script.length
        ? "use phone_listen to receive the next scripted caller line"
        : "no PHONE_SCRIPT is set, so phone_listen will report silence",
    };
  }

  const gateProblems = dialGates({ ...config, allowDial });
  if (gateProblems.length) {
    const [problem] = gateProblems;
    return { ...base, ok: false, blocked: true, code: problem.code, error: problem.message };
  }

  if (config.allowlist.length && !destinationAllowed(config.allowlist, number)) {
    return {
      ...base,
      ok: false,
      blocked: true,
      code: "not-allowlisted",
      error: `destination ${number.national} is not in PHONE_ALLOWLIST`,
      hint: `allowlist currently contains: ${config.allowlist.join(", ")}`,
    };
  }

  const dials = recentDialCount(config);
  if (dials >= config.maxCallsPerRun) {
    return {
      ...base,
      ok: false,
      blocked: true,
      code: "call-cap",
      error: `call cap reached (${dials} dials in the last hour, PHONE_MAX_CALLS=${config.maxCallsPerRun})`,
      hint: "raise PHONE_MAX_CALLS only if you intend a batch campaign",
    };
  }

  const placed = await deps.dial(config, number);
  if (!placed.ok) {
    audit(config, { event: "dial", id: null, to: number.national, ok: false, code: placed.code, error: placed.error });
    return {
      ...base,
      ok: false,
      code: placed.code || "dial-failed",
      state: placed.state || "UNKNOWN",
      error: placed.error,
      device: placed.device ? { serial: placed.device.serial, model: placed.device.model, state: placed.device.state } : null,
      hint: placed.device?.hint || null,
    };
  }

  const session = createSession({ id: newSessionId("call"), number, simulated: false });
  if (config.announceAi) addTurn(session, "system", "AI disclosure enabled: the assistant identifies itself as automated.", { note: true });
  persist(config, session);

  let greetingResult = null;
  if (greeting) greetingResult = await speakIntoCall(config, session, greeting, deps);

  audit(config, {
    event: "dial",
    id: session.id,
    to: number.national,
    ok: true,
    simulated: false,
    device: placed.device?.serial ?? null,
    greeting: greeting || null,
  });

  return {
    ok: true,
    ...base,
    code: "in-call",
    id: session.id,
    state: "IN_CALL",
    answered: Boolean(placed.answered),
    device: { serial: placed.device?.serial ?? null, model: placed.device?.model ?? null },
    greeting: greetingResult,
    hint: greetingResult && !greetingResult.ok ? "the call is live but the greeting failed to play; try phone_say or phone_hangup" : null,
  };
}

/** Speak into the active call. */
export async function say(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const session = loadSession(config);
  if (!session) {
    return { ok: false, code: "no-active-call", error: "there is no active call", hint: "dial first with phone_call / phone_dial" };
  }

  const result = await speakIntoCall(config, session, options.text, deps);
  audit(config, { event: "say", id: session.id, to: session.number.national, ok: result.ok, chars: result.chars ?? 0, error: result.error ?? null });
  return { ...result, id: session.id, state: session.state };
}

/**
 * Record one turn of the caller. With PHONE_LISTEN_UNTIL_SILENCE the window is
 * filled in short chunks and stops as soon as the caller goes quiet for
 * `silenceMs` — on a real call that is several seconds off every turn, and in
 * dead air it returns after the minimum window instead of the full one.
 * Without the flag the behaviour is the documented fixed window, untouched.
 */
async function captureTurn(config, deps, seconds) {
  if (!config.listenUntilSilence) {
    const rec = await deps.record(config, { seconds });
    return { ...rec, chunks: 1, vad: null };
  }

  const chunk = Math.min(2, seconds);
  const files = [];
  let heard = false;
  let trailing = 0;
  let total = 0;
  let rmsMax = 0;
  let backend = null;

  while (total < seconds) {
    const rec = await deps.record(config, { seconds: chunk });
    if (!rec.ok) {
      if (!files.length) return rec;
      break; // keep what we already captured
    }
    if (rec.path) files.push(rec.path);
    backend = rec.backend ?? backend;
    total += rec.duration || chunk;
    rmsMax = Math.max(rmsMax, rec.rms || 0);
    heard = heard || Boolean(rec.hasSpeech);
    const durMs = (rec.duration || chunk) * 1000;
    const tail = rec.path ? trailingSilenceMs(rec.path, { threshold: config.audio.minRms }) : durMs;
    trailing = tail >= durMs - 50 ? trailing + tail : tail;
    // stop when the caller finished a sentence…
    if (heard && trailing >= config.silenceMs) break;
    // …or when this turn is clearly dead air (cap the wait at 4 s)
    if (!heard && total >= Math.min(seconds, 4)) break;
  }

  if (!files.length) return { ok: false, code: "record-failed", error: "end-of-turn capture produced no audio" };

  let mergedPath = files[0];
  if (files.length > 1) {
    mergedPath = path.join(os.tmpdir(), `phone-bridge-turn-${process.pid}-${Date.now()}.wav`);
    try {
      concatWavFiles(files, mergedPath, { sampleRate: config.audio.sampleRate });
    } catch (error) {
      mergedPath = files[files.length - 1];
    }
  }
  return {
    ok: true,
    path: mergedPath,
    duration: total,
    rms: rmsMax,
    hasSpeech: heard || rmsMax >= config.audio.minRms,
    backend: backend || "chunked",
    chunks: files.length,
    chunkFiles: files,
    vad: { trailingSilenceMs: trailing, stoppedEarly: total < seconds },
  };
}

/**
 * Listen to the other side and transcribe.
 *
 * Recording always happens; transcription needs PHONE_STT_CMD. When STT is not
 * configured the result is still ok:true with an empty text and an explicit
 * `stt.notConfigured` flag — never a fabricated transcript.
 */
export async function listen(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const session = loadSession(config);
  if (!session) {
    return { ok: false, code: "no-active-call", error: "there is no active call", hint: "dial first with phone_call / phone_dial" };
  }

  const seconds = Math.max(2, Math.min(config.maxListenSeconds, Number(options.seconds) || config.listenSeconds));

  if (session.simulated) {
    const line = session.script[session.scriptIndex] ?? "";
    if (line) {
      session.scriptIndex += 1;
      addTurn(session, "caller", line);
      persist(config, session);
    }
    audit(config, { event: "listen", id: session.id, to: session.number.national, ok: true, simulated: true, chars: line.length });
    return {
      ok: true,
      id: session.id,
      state: session.state,
      text: line,
      empty: !line,
      simulated: true,
      hint: line ? null : "the scripted caller has no more lines; that is the end of the simulated conversation",
    };
  }

  const ended = await finalizeIfEnded(config, session, deps);
  if (ended.ended) {
    return {
      ok: true,
      id: session.id,
      state: "IDLE",
      text: "",
      empty: true,
      code: "call-ended",
      error: "the call ended before the caller said anything",
      transcript: transcriptText(session),
      hint: "the phone reported IDLE; the session was archived",
    };
  }

  const blocked = budgetBlock(config, session);
  if (blocked) return blocked;

  const recording = await captureTurn(config, deps, seconds);
  if (!recording.ok) {
    return {
      ok: false,
      id: session.id,
      state: session.state,
      code: recording.code || "record-failed",
      error: recording.error,
      hint: recording.hint,
    };
  }

  const transcription = await deps.transcribe(config, recording.path);
  if (transcription.ok) recordVoiceCost(session, "stt", transcription);
  if (!config.keepAudio) {
    try {
      for (const f of [recording.path, ...(recording.chunkFiles || [])]) {
        if (f && fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch {
      // best effort
    }
  }

  if (transcription.text) {
    addTurn(session, "caller", transcription.text, { hasSpeech: recording.hasSpeech, rms: Number(recording.rms?.toFixed?.(4) ?? recording.rms) });
    persist(config, session);
  }

  const sttInfo = transcription.ok
    ? { ok: true, configured: true, engine: transcription.engine ?? "cmd", model: transcription.model ?? null, usd: transcription.usd ?? null, ms: transcription.ms ?? null }
    : { ok: false, configured: Boolean(config.stt.command || config.stt.engine === "aval"), code: transcription.code, hint: transcription.hint };

  persist(config, session);
  const spent = voiceSpend(session);

  audit(config, {
    event: "listen",
    id: session.id,
    to: session.number.national,
    ok: transcription.ok,
    seconds: Number((recording.duration || seconds).toFixed(1)),
    hasSpeech: recording.hasSpeech,
    rms: recording.rms,
    chars: transcription.text.length,
    stt: transcription.model || transcription.code || null,
    usd: transcription.usd ?? null,
    voice_usd_total: spent,
  });

  const hints = [];
  if (!recording.hasSpeech) hints.push(recording.hint || "the recording is silent");
  if (!transcription.ok) hints.push(transcription.hint || transcription.error);

  return {
    ok: true,
    id: session.id,
    state: session.state,
    text: transcription.text,
    empty: !transcription.text,
    hasSpeech: recording.hasSpeech,
    rms: recording.rms,
    seconds: Number((recording.duration || seconds).toFixed(1)),
    vad: recording.vad ?? null,
    stt: sttInfo,
    usd: transcription.usd ?? null,
    voice_usd_total: spent,
    recording: { backend: recording.backend, duration: recording.duration, warning: recording.warning ?? null },
    hint: hints.length ? hints.filter(Boolean).join(" | ") : null,
  };
}

/** End the call and archive the transcript. */
export async function hangup(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const session = loadSession(config);

  if (!session) {
    return { ok: true, code: "no-active-call", state: "IDLE", hint: "nothing to hang up" };
  }

  let result;
  if (session.simulated) {
    result = { ok: true, code: "hung-up", state: "IDLE" };
  } else {
    result = await deps.hangup(config);
  }

  const closed = await closeSession(config, session, { reason: result.code || "hangup", live: result });
  audit(config, {
    event: "hangup",
    id: session.id,
    to: session.number.national,
    ok: result.ok,
    turns: session.turns.length,
    durationSeconds: durationSeconds(session),
    archive: closed.archive,
  });

  return {
    ok: result.ok,
    code: result.code,
    state: result.state,
    id: session.id,
    durationSeconds: durationSeconds(session),
    turns: session.turns.length,
    transcript: transcriptText(session),
    archive: closed.archive,
    error: result.ok ? null : `could not confirm the hangup (state: ${result.state}); check the phone`,
  };
}

/** Current call status; reconciles a session with the phone's live state. */
export async function status(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const session = loadSession(config);

  if (!session) {
    if (config.simulate) {
      return { ok: true, state: "IDLE", session: null, simulated: true };
    }
    const live = await deps.callState(config);
    return {
      ok: true,
      state: live.ok ? live.state : "DISCONNECTED",
      session: null,
      device: live.device ? { state: live.device.state, serial: live.device.serial, model: live.device.model } : null,
    };
  }

  if (session.simulated) {
    return { ok: true, state: "SIMULATED", session: sessionInfo(session), transcript: transcriptText(session) };
  }

  const ended = await finalizeIfEnded(config, session, deps);
  if (ended.ended) {
    return {
      ok: true,
      state: "IDLE",
      code: "call-ended",
      session: { ...sessionInfo(session), endedAt: session.endedAt },
      transcript: transcriptText(session),
      hint: "the phone ended the call and the session was archived; dial again for a new call",
    };
  }

  return {
    ok: true,
    state: ended.live.state,
    session: sessionInfo(session),
    transcript: transcriptText(session),
    device: ended.live.device ? { serial: ended.live.device.serial, model: ended.live.device.model } : null,
  };
}

/** Everything the operator needs to know before the first real call. */
export async function readiness(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const checks = [];

  if (config.simulate) {
    checks.push({
      id: "mode",
      ok: true,
      detail: "simulation: calls are scripted and never touch the phone or the audio route",
      hint: "unset PHONE_SIMULATE for real calls",
    });
    checks.push({ id: "adb", ok: true, skipped: true, detail: "not needed in simulation" });
    checks.push({ id: "audio", ok: true, skipped: true, detail: "not needed in simulation" });
    checks.push({ id: "tts", ok: true, skipped: true, detail: "not needed in simulation" });
  } else {
    const device = await deps.deviceStatus(config);
    checks.push({
      id: "adb",
      ok: device.state !== "NO_ADB",
      detail: device.state === "NO_ADB" ? device.hint : `adb is runnable (${config.adb.path})`,
      hint: device.state === "NO_ADB" ? device.hint : null,
    });
    checks.push({
      id: "device",
      ok: device.ok,
      detail: device.ok ? `${device.model} (${device.serial}) is connected and authorized` : device.hint,
      hint: device.ok ? null : device.hint,
      devices: device.devices,
    });

    const voices = await deps.listVoices();
    const cloudTts = config.tts.engine === "aval";
    const customTts = config.tts.engine === "cmd";
    const avalTts = config.aval || {};
    const persianCapable = cloudTts ? Boolean(avalTts.apiKey && avalTts.ttsModel) : customTts ? Boolean(config.tts.command) : Boolean(voices.hasPersian);
    checks.push({
      id: "tts",
      ok: cloudTts
        ? persianCapable
        : Boolean(persianCapable && (customTts || (voices.ok && voices.voices.length))),
      detail: cloudTts
        ? avalTts.ttsModel
          ? avalTts.apiKey
            ? `aval voice: ${avalTts.ttsModel}${avalTts.ttsVoice ? ` (${avalTts.ttsVoice})` : ""} — Persian speech through the Aval API`
            : "PHONE_TTS_ENGINE=aval but no Aval key is available (set AVAL_API_KEY)"
          : "PHONE_TTS_ENGINE=aval but PHONE_AVAL_TTS_MODEL is empty"
        : customTts
        ? config.tts.command
          ? `custom TTS command: ${config.tts.command.split(/\s+/)[0]}`
          : "PHONE_TTS_ENGINE=cmd but PHONE_TTS_CMD is empty"
        : voices.ok
          ? `${voices.voices.length} SAPI voice(s) installed${voices.hasPersian ? " including Persian" : "; none of them can read Persian script"}` +
            (persianCapable ? "" : " — Persian replies would produce silence")
          : voices.error,
      hint: cloudTts
        ? persianCapable
          ? null
          : "set AVAL_API_KEY and PHONE_AVAL_TTS_MODEL (see bench/voice/VOICE-RESULTS.md for the measured best Persian voice)"
        : customTts
          ? config.tts.command
            ? null
            : "set PHONE_TTS_CMD (for example Piper with a fa_IR model) or switch to PHONE_TTS_ENGINE=sapi"
          : voices.hasPersian
            ? null
            : "Windows English voices write an empty file for Persian text. Install a Persian Windows speech voice (Settings → Time & language → Language & region → Persian → Language options → Speech), set PHONE_TTS_ENGINE=aval, or set PHONE_TTS_CMD (Piper fa_IR, espeak-ng -v fa).",
      voices: cloudTts ? [] : voices.voices,
      persian: persianCapable,
      engine: config.tts.engine,
    });

    const backend = await deps.audioBackend(config);
    const endpoints = await deps.listAudio();
    checks.push({
      id: "audio",
      ok: backend !== "none",
      detail: backend === "none" ? "no audio backend available" : `capture backend: ${backend}`,
      hint:
        backend === "none"
          ? "install ffmpeg (winget install Gyan.FFmpeg) or run on Windows with PHONE_AUDIO_BACKEND=mci"
          : endpoints.hint,
      backend,
      endpoints: endpoints.endpoints ?? [],
    });

    const sttInfo = stt.sttStatus(config);
    checks.push({
      id: "stt",
      ok: sttInfo.ok,
      optional: true,
      detail: sttInfo.ok ? `speech-to-text: ${sttInfo.engine}` : "no speech-to-text engine configured",
      hint: sttInfo.ok ? null : sttInfo.hint,
      engine: config.stt.engine,
    });
    const aval = config.aval || {};
    const voice = config.tts.engine === "aval" || config.stt.engine === "aval";
    checks.push({
      id: "voice-budget",
      ok: !voice || aval.budgetUsdPerCall > 0,
      optional: !voice,
      detail: voice
        ? aval.apiKey
          ? `Aval voice spend is capped at $${aval.budgetUsdPerCall} per call; the key comes from AVAL_API_KEY / the Aval provider config`
          : "cloud voice is selected but no Aval key was found"
        : "voice is local, nothing is billed per turn",
      hint: voice && !aval.budgetUsdPerCall ? "PHONE_AVAL_BUDGET_USD=0 disables the cap — set a real number before dialling" : null,
    });
  }

  const allowlistCheck = {
    id: "safety",
    ok: true,
    detail: config.allowlist.length ? `allowlist: ${config.allowlist.join(", ")}` : "no allowlist (any valid Iranian number may be dialed once approved)",
    hint: config.allowlist.length ? null : "set PHONE_ALLOWLIST to restrict the secretary to known numbers",
  };
  checks.push(allowlistCheck);
  checks.push({
    id: "approval",
    ok: config.allowDial,
    detail: config.allowDial ? "real dialing is approved (PHONE_ALLOW_DIAL=1)" : "real dialing is blocked until PHONE_ALLOW_DIAL=1",
    hint: config.allowDial ? null : "this is deliberate: an agent must not decide on its own to dial real people",
  });

  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  const readyToDial = config.simulate || Boolean(byId.device?.ok && byId.audio?.ok && byId.tts?.ok && (byId["voice-budget"]?.ok ?? true));
  const readyToTalk = config.simulate || Boolean(readyToDial && byId.stt?.ok);

  const nextSteps = checks
    .filter((check) => !check.ok && !check.skipped && check.id !== "approval")
    .map((check) => check.hint || check.detail);

  if (!config.allowDial && !config.simulate) {
    nextSteps.push("when the phone and audio route are verified, set PHONE_ALLOW_DIAL=1 for the session that should be allowed to dial");
  }

  return {
    ok: readyToDial,
    readyToDial,
    readyToTalk,
    mode: config.simulate ? "simulate" : config.allowDial ? "live" : "preview",
    checks,
    nextSteps,
    audio: { backend: byId.audio?.backend ?? null, endpoints: byId.audio?.endpoints ?? [] },
    voices: byId.tts?.voices ?? [],
  };
}

/** Round-trip audio check: speak a phrase, then record what came back. */
export async function selftest(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const seconds = Math.max(2, Math.min(8, Number(options.seconds) || 4));
  const phrase = options.phrase || "سلام، این یک آزمایش مسیر صدا برای تماس تلفنی است.";

  const steps = [];
  const synth = await deps.synthesize(config, phrase);
  steps.push({
    step: "tts",
    ok: synth.ok,
    detail: synth.ok ? `${synth.engine} / ${synth.voice} (${synth.culture || "unknown culture"})` : synth.error,
    warning: synth.warning ?? null,
    hint: synth.hint ?? null,
  });
  if (!synth.ok) return { ok: false, steps, error: "text-to-speech failed", hint: synth.hint };

  const played = await deps.play(config, synth.path);
  steps.push({
    step: "play",
    ok: played.ok,
    detail: played.ok ? `played ${played.duration?.toFixed?.(1) ?? "?"}s through ${played.backend}` : played.error,
    hint: played.ok ? null : "check the Windows default playback device; it must be the phone link",
  });

  const recording = await deps.record(config, { seconds });
  steps.push({
    step: "record",
    ok: recording.ok,
    detail: recording.ok
      ? `${recording.duration?.toFixed?.(1) ?? "?"}s via ${recording.backend}, RMS ${Number(recording.rms ?? 0).toFixed(4)}`
      : recording.error,
    hint: recording.ok ? recording.hint : recording.hint,
  });

  try {
    const fs = await import("node:fs");
    if (synth.path && fs.existsSync(synth.path) && !config.keepAudio) fs.unlinkSync(synth.path);
    if (recording.path && fs.existsSync(recording.path) && !config.keepAudio) fs.unlinkSync(recording.path);
  } catch {
    // best effort
  }

  const heard = Boolean(recording.ok && recording.hasSpeech);
  return {
    ok: Boolean(synth.ok && played.ok && heard),
    steps,
    heard,
    hint: heard
      ? null
      : "the PC did not hear the phrase it just spoke. With Bluetooth HFP the phone must be in a call; with a virtual cable the recording device must be CABLE Output. Acoustic echo is not a valid test.",
  };
}

/** Voice list for the CLI. */
export async function voices(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const installed = await deps.listVoices();
  const selected = installed.ok ? tts.pickVoice(config.tts.voice, installed.voices) : null;
  return { ...installed, selected: selected?.name ?? null, configured: config.tts.voice || null };
}

/** Audio endpoint list for the CLI. */
export async function audioEndpoints(options = {}) {
  const config = options.config || loadConfig();
  const deps = resolveDeps(options.deps);
  const endpoints = await deps.listAudio();
  const backend = await deps.audioBackend(config);
  return { ...endpoints, backend, configuredInput: config.audio.inputDevice || null, configuredOutput: config.audio.outputDevice || null };
}
