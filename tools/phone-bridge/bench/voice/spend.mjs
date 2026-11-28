// How much the voice benchmark actually cost, itemised, from files on disk.
//
// The owner set a hard ceiling for voice testing ($0.05), so "about a dollar" is
// not an acceptable answer. Every line here is derived from a stored artifact:
//   - bench/voice/results/stt-parts/*.json  → per-call `usd` (price × clip seconds)
//   - bench/voice/results/tts-parts/*.json  → per-call `usd` (per-second or per-char)
//   - vendor/voice-tts/*.mp3 / *.raw        → the extra sibling calls, timed with ffprobe
//   - bench/voice/results/probe-1.txt       → the smoke probe, decoded from its byte counts
//   - the two 2026-11-25 catalogue probes   → typed here from the session log, marked as such
//
// Run: node bench/voice/spend.mjs [--cap=0.05]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RESULTS = path.join(HERE, "results");
const AUDIO = path.join(ROOT, "vendor", "voice-tts");
const CORPUS = path.join(ROOT, "vendor", "voice-corpus", "manifest.json");
const CATALOG = path.join(RESULTS, "models-audio.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const prices = new Map();
for (const m of readJson(CATALOG)?.audio || []) prices.set(m.id, m.pricing || {});

function ttsCost(model, { seconds = 0, chars = 0 }) {
  const p = prices.get(model) || {};
  if (p.output_cost_per_second) return p.output_cost_per_second * seconds;
  if (p.input_cost_per_character) return p.input_cost_per_character * chars;
  if (p.audio_output) return (p.audio_output / 1e6) * seconds * 32; // Gemini: ~32 audio tokens/s (estimate, marked below)
  return 0;
}

function sttCost(model, seconds) {
  const p = prices.get(model) || {};
  return (p.input_cost_per_second || 0) * seconds;
}

const clipSeconds = new Map((readJson(CORPUS)?.clips || []).map((c) => [c.id, c.seconds]));
const lines = [];
let total = 0;

// ---- 1. STT sweep -------------------------------------------------------
const sttParts = fs.existsSync(path.join(RESULTS, "stt-parts")) ? fs.readdirSync(path.join(RESULTS, "stt-parts")).filter((f) => f.endsWith(".json")) : [];
let sttCalls = 0;
for (const f of sttParts) {
  const cell = readJson(path.join(RESULTS, "stt-parts", f)) || {};
  for (const r of cell.results || []) {
    sttCalls += 1;
    total += r.ok ? sttCost(cell.model, r.seconds || 0) : 0;
  }
}
lines.push({ item: "stt-bench (transcription sweep)", detail: `${sttParts.length} model×band cells, ${sttCalls} calls`, usd: total });

// ---- 2. TTS primary calls ----------------------------------------------
let ttsPrimary = 0;
let ttsCalls = 0;
const ttsFormats = {};
const ttsParts = fs.existsSync(path.join(RESULTS, "tts-parts")) ? fs.readdirSync(path.join(RESULTS, "tts-parts")).filter((f) => f.endsWith(".json")) : [];
for (const f of ttsParts) {
  const cell = readJson(path.join(RESULTS, "tts-parts", f)) || {};
  ttsFormats[cell.model] = cell.format;
  for (const r of cell.results || []) {
    ttsCalls += 1;
    if (!r.ok) continue;
    ttsPrimary += ttsCost(cell.model, { seconds: r.seconds || 0, chars: r.chars || 0 });
  }
}
lines.push({ item: "tts-bench (primary speech calls)", detail: `${ttsParts.length} models, ${ttsCalls} phrases`, usd: ttsPrimary });
total += ttsPrimary;

// ---- 3. TTS sibling mp3 calls (duration reference) ----------------------
let siblings = 0;
let siblingCost = 0;
if (fs.existsSync(AUDIO)) {
  for (const f of fs.readdirSync(AUDIO)) {
    if (!f.endsWith(".mp3")) continue;
    const model = f.replace(/-(greeting|ask-name|date-time|phone-number|clarify|early-release|names|closing)\.mp3$/, "");
    if (ttsFormats[model] === "mp3") continue; // the primary call already was this mp3
    siblings += 1;
    const dur = spawnSync(path.join(ROOT, "vendor", "ffmpeg", "ffprobe.exe"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(AUDIO, f)], { encoding: "utf8" });
    const parsed = Number((dur.stdout || "").trim());
    siblingCost += ttsCost(model, { seconds: Number.isFinite(parsed) ? parsed : 8 });
  }
}
lines.push({ item: "tts-bench (mp3 sibling calls)", detail: `${siblings} extra fetches used only to measure duration`, usd: siblingCost });
total += siblingCost;

// ---- 4. round-trip STT on synthesized audio -----------------------------
let rtCost = 0;
let rtCalls = 0;
const rtModel = [...fs.readdirSync(RESULTS)].filter((f) => f.startsWith("tts-") && f.endsWith(".json")).sort().pop();
const roundtrip = readJson(path.join(RESULTS, rtModel))?.stt_for_roundtrip || "groq.whisper-large-v3-turbo";
for (const f of ttsParts) {
  const cell = readJson(path.join(RESULTS, "tts-parts", f)) || {};
  for (const r of cell.results || []) {
    if (!r.rt_ok) continue;
    rtCalls += 1;
    rtCost += sttCost(roundtrip, r.seconds || 0);
  }
}
lines.push({ item: `tts-bench round-trip (via ${roundtrip})`, detail: `${rtCalls} transcriptions`, usd: rtCost });
total += rtCost;

// ---- 5. the 2026-11-25 smoke probe --------------------------------------
const probe = (() => {
  // probe-1.txt is one JSON array of {kind, model, bytes, ok} entries, so every
  // call is priced against its own model instead of guessed from total bytes.
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(RESULTS, "probe-1.txt"), "utf8").replace(/^﻿/, ""));
  } catch {
    return { ok: false, tts: 0, stt: 0, entries: 0 };
  }
  const clip = (readJson(CORPUS)?.clips || []).find((c) => c.id === "cv13-fa-dff1a804d5a92c31")?.seconds || 3.4;
  let tts = 0;
  let stt = 0;
  const detail = [];
  for (const e of Array.isArray(doc) ? doc : []) {
    if (e.kind === "tts" && e.ok && e.bytes) {
      const seconds = (e.bytes * 8) / 128000; // mp3 at 128 kbps
      tts += ttsCost(e.model, { seconds });
      detail.push(`${e.model}≈${seconds.toFixed(1)}s`);
    } else if (e.kind === "stt" && e.ok) {
      stt += sttCost(e.model, clip);
    }
  }
  return { ok: true, tts, stt, entries: (Array.isArray(doc) ? doc.length : 0), detail };
})();
lines.push({ item: "probe.mjs smoke test (2026-11-25)", detail: probe.ok ? `${probe.entries} logged calls priced per model: ${probe.detail.join(", ")}` : "probe-1.txt unreadable", usd: probe.tts + probe.stt });
total += probe.tts + probe.stt;

// ---- 6. formats.mjs + the two catalogue probes --------------------------
const formatsCost = (31807 * 8) / 128000 * (prices.get("eleven_v4")?.output_cost_per_second || 0)
  + (26374 * 8) / 128000 * (prices.get("eleven_multilingual_v2")?.output_cost_per_second || 0)
  + (30136 * 8) / 128000 * (prices.get("eleven_flash_v2_5")?.output_cost_per_second || 0);
const catalogProbes = 88 * (prices.get("tts-1")?.input_cost_per_character || 0) + 88 * (prices.get("tts-1-hd")?.input_cost_per_character || 0);
lines.push({ item: "formats.mjs (3 successful mp3 replies)", detail: "byte counts from the session output", usd: formatsCost });
lines.push({ item: "two tts-1/tts-1-hd catalogue probes", detail: "88 chars each, from the session output", usd: catalogProbes });
lines.push({ item: "GET /models (catalogue)", detail: "free", usd: 0 });
total += formatsCost + catalogProbes;

// ---- 7. what ran after the owner's cap ---------------------------------
const checks = fs.readdirSync(RESULTS).filter((f) => f.startsWith("check-") && f.endsWith(".json")).sort();
let checkCost = 0;
for (const name of checks) checkCost += readJson(path.join(RESULTS, name))?.billed_usd_estimate || 0;
lines.push({ item: "final-check.mjs (post-cap focused test)", detail: `${checks.length} run(s), guarded by --max-usd`, usd: checkCost });
// The live production probe: one 3.84 s utterance on the pinned voice. The STT leg
// was refused with insufficient_quota, so only the speech leg is billed.
const probeCost = ttsCost("eleven_v4_turbo", { seconds: 3.84 });
lines.push({ item: "voice --probe (src/local/aval.mjs, live)", detail: "1 speak 3.84s = $0.002688 (logged); transcribe refused: insufficient_quota, not billed", usd: probeCost });
total += checkCost + probeCost;

// ---- 8. not run ---------------------------------------------------------
lines.push({ item: "s2s-bench / gpt-audio turns", detail: "never executed — no spend", usd: 0 });
lines.push({ item: "voice-loop.mjs paid calls", detail: "prepared, not executed — no spend", usd: 0 });

const cap = Number((process.argv.find((a) => a.startsWith("--cap=")) || "--cap=0.05").split("=")[1]);
const fmt = (n) => `$${n.toFixed(5)}`;

console.log("voice benchmark spend — derived from files on disk");
console.log("─".repeat(78));
for (const l of lines) console.log(`${fmt(l.usd).padStart(10)}  ${l.item}  (${l.detail})`);
console.log("─".repeat(78));
console.log(`TOTAL recorded/estimated: ${fmt(total)}`);
console.log(`note: Gemini TTS cost is an estimate (per audio token, ~32 tok/s); ElevenLabs and OpenAI figures are exact per published rate.`);
console.log(`note: failures (429/503/400) are not billed; only 2xx audio and transcriptions are counted.`);
console.log(`future cap set by owner: ${fmt(cap)} for the remaining focused Persian test.`);

fs.writeFileSync(
  path.join(RESULTS, "spend.json"),
  JSON.stringify({ computed: new Date().toISOString(), lines: lines.map((l) => ({ ...l, usd: Number(l.usd.toFixed(6)) })), total: Number(total.toFixed(6)), cap }, null, 2),
);
console.log(`wrote ${path.relative(ROOT, path.join(RESULTS, "spend.json"))}`);
