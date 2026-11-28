// The owner's focused final check, inside a hard spend guard.
//
// Rules this file enforces (the owner capped voice testing at $0.05 total, and the
// sweeps already blew past it — so nothing here runs without a price printed first):
//   * every call's cost is computed from the catalogue price and the measured audio
//     length BEFORE the call is made, and the plan total is checked against --max-usd
//     (default $0.01). If the plan is too expensive, it exits without calling anything.
//   * no new speech is synthesised: it reuses the audio the sweep already produced.
//   * every call is logged with model, ms, bytes and cost.
//
// What it answers:
//   1. does the pinned STT understand the pinned TTS's Persian (cross-engine round-trip)?
//   2. how do the two candidate transcriptions differ on the same audio?
//   3. what does one call cost, per candidate, at 90 s TTS + 90 s STT?
//
// Run: node bench/voice/final-check.mjs [--max-usd=0.01]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AvalVoice, resolveKey } from "./lib/api.mjs";
import { cer, fold, latinShare, persianShare } from "./lib/text.mjs";
import { PHRASES } from "./phrases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const AUDIO = path.join(ROOT, "vendor", "voice-tts");
const LISTEN = path.join(ROOT, "vendor", "voice-listen");
const RESULTS = path.join(HERE, "results");
const FFPROBE = path.join(ROOT, "vendor", "ffmpeg", "ffprobe.exe");

const STT_CANDIDATES = ["scribe_v2", "gpt-4o-mini-transcribe"];
const TTS_CANDIDATES = ["eleven_flash_v2_5", "eleven_v4_turbo", "gemini-3.8-flash-tts", "tts-1"];
const PHRASE = PHRASES.find((p) => p.id === "greeting");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

const catalog = JSON.parse(fs.readFileSync(path.join(RESULTS, "models-audio.json"), "utf8"));
const price = new Map(catalog.audio.map((m) => [m.id, m.pricing || {}]));

function secondsOf(file) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const n = Number((r.stdout || "").trim());
  return Number.isFinite(n) ? n : null;
}

function sttUsd(model, seconds) {
  return (price.get(model)?.input_cost_per_second || 0) * seconds;
}

function ttsUsd(model, seconds, chars) {
  const p = price.get(model) || {};
  if (p.output_cost_per_second) return p.output_cost_per_second * seconds;
  if (p.input_cost_per_character) return p.input_cost_per_character * chars;
  if (p.audio_output) return (p.audio_output / 1e6) * seconds * 32; // Gemini: ~32 audio tokens/s, estimate
  return 0;
}

async function main() {
  const maxUsd = Number(arg("max-usd", 0.01));
  if (!fs.existsSync(AUDIO)) {
    console.error(`no audio in ${path.relative(ROOT, AUDIO)} — nothing to check without spending on new speech`);
    process.exit(2);
  }
  fs.mkdirSync(LISTEN, { recursive: true });

  // ---- plan -------------------------------------------------------------
  const targets = [];
  for (const model of TTS_CANDIDATES) {
    const wav = path.join(AUDIO, `${model}-greeting.wav`);
    if (!fs.existsSync(wav)) continue;
    const seconds = secondsOf(wav);
    if (!seconds) continue;
    targets.push({ model, wav, seconds });
  }
  const plan = [];
  for (const t of targets) for (const stt of STT_CANDIDATES) plan.push({ tts: t.model, stt, file: path.basename(t.wav), seconds: t.seconds, usd: Number(sttUsd(stt, t.seconds).toFixed(6)) });
  const planned = Number(plan.reduce((a, p) => a + p.usd, 0).toFixed(6));

  console.log(`sentence (${PHRASE.text.length} chars): ${PHRASE.text}`);
  console.log(`audio on disk: ${targets.map((t) => `${t.model} ${t.seconds.toFixed(1)}s`).join(", ") || "none"}`);
  console.log(`\nplanned requests (${plan.length}):`);
  for (const p of plan) console.log(`  ${p.stt.padEnd(24)} ${p.file.padEnd(34)} ${p.seconds.toFixed(1)}s  $${p.usd.toFixed(6)}`);
  console.log(`planned total: $${planned.toFixed(6)}   guard: $${maxUsd.toFixed(4)}`);
  if (planned > maxUsd) {
    console.error(`refusing to run: the plan costs $${planned.toFixed(5)} > --max-usd $${maxUsd.toFixed(5)}`);
    process.exit(3);
  }
  if (!targets.length) {
    console.error("no greeting.wav found for any candidate");
    process.exit(2);
  }

  // ---- listening pack (free: files the sweep already produced) ----------
  const pack = [];
  for (const t of targets) {
    const dest = path.join(LISTEN, `${t.model}-greeting.wav`);
    fs.copyFileSync(t.wav, dest);
    pack.push({ model: t.model, file: path.relative(ROOT, dest), seconds: Number(t.seconds.toFixed(2)), rms: null });
  }
  fs.writeFileSync(
    path.join(LISTEN, "README.md"),
    [
      "# شنیدنی — صدای فارسی ساخته‌شده با مدل‌های Aval",
      "",
      "همه با **یک جملهٔ واحد** ساخته شده‌اند تا مقایسهٔ گوشت منصفانه باشد:",
      "",
      `> ${PHRASE.text}`,
      "",
      "| فایل | مدل | طول | CER رفت‌وبرگشت در sweep |",
      "|---|---|---|---|",
      ...pack.map((p) => `| \`${path.basename(p.file)}\` | ${p.model} | ${p.seconds}s | ${roundTripCer(p.model)} |`),
      "",
      "این پوشه gitignored است (زیر vendor/). اگر صدا را نشنیدید یا لهجه غلط بود،",
      "انتخاب TTS باید عوض شود — هیچ selftest‌ی جای گوش انسان را نمی‌گیرد (L5).",
      "",
    ].join("\n"),
  );

  // ---- calls -------------------------------------------------------------
  const voice = new AvalVoice({ key: resolveKey(process.env, path.join(ROOT, "phone.config.json")), timeoutMs: 60000 });
  if (!voice.key) {
    console.error("no key: set AVAL_API_KEY");
    process.exit(2);
  }
  const rows = [];
  for (const p of plan) {
    const buf = fs.readFileSync(path.join(AUDIO, p.file));
    const res = await voice.transcribe({ model: p.stt, file: buf, filename: p.file, language: "fa" });
    const row = {
      tts: p.tts,
      stt: p.stt,
      usd_planned: p.usd,
      ok: res.ok,
      ms: res.ms,
      text: res.ok ? res.text : null,
      error: res.ok ? null : String(res.error || "").slice(0, 160),
      cer: res.ok ? Number(cer(PHRASE.text, res.text).toFixed(4)) : null,
      persian: res.ok ? Number(persianShare(res.text).toFixed(2)) : null,
      latin: res.ok ? Number(latinShare(res.text).toFixed(3)) : null,
    };
    rows.push(row);
    console.log(`  → ${p.stt.padEnd(24)} ${row.ok ? `cer=${row.cer} $${p.usd.toFixed(6)} ${row.ms}ms` : `FAIL ${row.error}`}  ${fold(row.text || "").slice(0, 46)}`);
    p.actual = row;
  }

  // ---- per-call cost table (no API: arithmetic on published prices) ------
  const perCall = TTS_CANDIDATES.map((model) => {
    const p = price.get(model) || {};
    const tts90 = ttsUsd(model, 90, 900);
    return {
      model,
      basis: p.output_cost_per_second ? "per audio second" : p.input_cost_per_character ? "per character (≈900 chars)" : p.audio_output ? "per audio token (≈32/s, estimate)" : "unknown",
      usd_per_90s_tts: Number(tts90.toFixed(5)),
    };
  }).concat(
    STT_CANDIDATES.map((model) => ({ model, basis: "per audio second", usd_per_90s_tts: Number(sttUsd(model, 90).toFixed(5)), role: "stt" })),
  );

  const spent = Number(rows.filter((r) => r.ok).reduce((a, r) => a + r.usd_planned, 0).toFixed(6));
  const out = {
    created: new Date().toISOString(),
    sentence: PHRASE,
    guard_usd: maxUsd,
    planned_usd: planned,
    billed_usd_estimate: spent,
    rows,
    per_call_90s: perCall,
    listening_pack: pack,
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `check-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\n| pair | CER | Persian share | cost |`);
  console.log(`|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r.tts} → ${r.stt} | ${r.cer ?? "ERR"} | ${r.persian ?? "-"} | $${r.usd_planned.toFixed(6)} |`);
  console.log(`\nper-call (90s each side):`);
  for (const c of perCall) console.log(`  ${c.model.padEnd(24)} ${(c.role || "tts").padEnd(4)} $${c.usd_per_90s_tts.toFixed(5)}  (${c.basis})`);
  console.log(`\nbilled estimate: $${spent.toFixed(6)} of the $${maxUsd} guard`);
  console.log(`listening pack: ${path.relative(ROOT, LISTEN)} (${pack.length} files)`);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

/** CER already measured for that voice in the sweep, if any. */
function roundTripCer(model) {
  try {
    const cell = JSON.parse(fs.readFileSync(path.join(RESULTS, "tts-parts", `${model}.json`), "utf8"));
    const list = (cell.results || []).map((r) => r.cer).filter((v) => Number.isFinite(v));
    return list.length ? (list.reduce((a, b) => a + b, 0) / list.length).toFixed(4) : "—";
  } catch {
    return "—";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
