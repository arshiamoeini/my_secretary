// Persian text-to-speech benchmark against every speech model Aval.ai offers.
//
// Candidates come from GET /v1/models (mode === "audio_speech"), so the whole
// catalogue is covered: OpenAI TTS, ElevenLabs, Gemini TTS, PlayAI.
//
// What is measured per model:
//   validity  — real audio bytes, non-silent, sensible duration (the old SAPI
//               path wrote 46-byte "success" files; that must never pass here)
//   latency   — ms to first byte and RTF, because a caller hears the pause
//   cost      — from the model's own price (per character or per second)
//   fidelity  — round-trip: audio → best STT model → text, then CER against the
//               source sentence. A Persian voice that mangles vowels scores bad;
//               a model that reads Persian with an English voice scores very bad.
//
// Human listening (L5) is still required before a live call; this bench can
// reject a bad voice, it cannot approve a good one.
//
// Usage: node bench/voice/tts-bench.mjs [--stt=<model>] [--phrases=4] [--models=a,b] [--force]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvalVoice, resolveKey, retry } from "./lib/api.mjs";
import { cer, fold, latinShare, persianShare } from "./lib/text.mjs";
import { ffmpegOrNull, probe, rms, detectPcmRate, toWav } from "./lib/audio.mjs";
import { pcm16ToWav } from "../../src/local/aval.mjs";
import { PHRASES } from "./phrases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RESULTS = path.join(HERE, "results");
const OUT = process.env.VOICE_TTS_OUT || path.join(ROOT, "vendor", "voice-tts");

const VOICE_CANDIDATES = {
  openai: ["alloy", "nova"],
  elevenlabs: ["onwK4e9ZLuTAKqWW03F9", "21m00Tcm4TlvDq8ikWAM"],
  google: ["Kore", "Puck"],
  "play ai": ["atlas"],
  runwayml: ["alloy"],
  default: ["alloy"],
};

// Models the catalogue lists but the API refuses. Each exclusion states its
// reason so the report cannot quietly drop a candidate.
// runwayml.eleven_multilingual_v2 is NOT excluded: it is an ElevenLabs route with
// a materially different price ($0.000015/char vs $0.005/s), so it is measured.
const SKIP = {
  "groq.playai-tts": "404 from the API: 'model has been deprecated' (probe 2026-11-25)",
  "groq.playai-tts-arabic": "same PlayAI family, same deprecation; Arabic-tuned anyway",
};

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : NaN);
const pctl = (l, q) => (l.length ? [...l].sort((a, b) => a - b)[Math.min(l.length - 1, Math.floor(q * (l.length - 1)))] : NaN);

function latestSttModel() {
  const files = fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS).filter((f) => f.startsWith("stt-") && f.endsWith(".json")) : [];
  if (!files.length) return null;
  const rows = [];
  for (const f of files.sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(RESULTS, f), "utf8"));
    for (const s of doc.summary || []) rows.push(s);
  }
  const passing = rows.filter((s) => s.pass && Number.isFinite(s.cer_mean));
  const phone = passing.filter((s) => s.band === "phone");
  // Use an STT engine from a DIFFERENT vendor family than the TTS under test:
  // scoring an ElevenLabs voice with ElevenLabs Scribe would reward one company's
  // internal consistency instead of measuring what a caller hears.
  const independent = phone.filter((s) => !/scribe|eleven/i.test(s.model));
  const ranked = (independent.length ? independent : phone).sort((a, b) => a.cer_mean - b.cer_mean);
  return ranked[0]?.model || passing.sort((a, b) => a.cer_mean - b.cer_mean)[0]?.model || null;
}

function fmtFor(owner) {
  return String(owner).toLowerCase().includes("google") ? "pcm" : "wav";
}

/**
 * Try the formats the bridge can actually use without a transcoder, in order.
 * `wav`/`pcm` only: mp3 at call time would need ffmpeg on the call path.
 * Which format each engine accepts is a real difference between them, so it is
 * recorded, not assumed.
 */
async function synthOnce(voice, { model, owner, text, format, formats, speed, tries = 3, rateBaseMs = 20000, sleep = () => {} }) {
  const voices = VOICE_CANDIDATES[owner] ? VOICE_CANDIDATES[owner] : VOICE_CANDIDATES.default;
  const triesList = formats && formats.length ? formats : [format];
  const attempts = [];
  for (const f of triesList) {
    for (const v of voices) {
      await sleep();
      const res = await retry(() => voice.speech({ model, input: text, voice: v, format: f, speed }), { tries, baseMs: rateBaseMs });
      if (res.ok && res.bytes && res.bytes.byteLength > 1000) return { ...res, voice: v, format: f, attempts };
      attempts.push(`${f}/${v}:${res.status || "net"}`);
      // a voice that returns a tiny payload is a silent failure, keep trying
      if (res.ok && (!res.bytes || res.bytes.byteLength <= 1000)) attempts.push(`${f}/${v}:empty`);
      if (!res.ok && res.status && res.status !== 400 && res.status !== 422) break; // the model itself refuses this format
    }
  }
  return { ok: false, error: attempts.join(" ") || "no audio", attempts };
}

async function main() {
  const key = resolveKey(process.env, path.join(ROOT, "phone.config.json"));
  if (!key) {
    console.error("no Aval api key");
    process.exit(2);
  }
  const sttModel = String(arg("stt", latestSttModel() || ""));
  if (!sttModel) console.log("! no STT model found in results/ — round-trip fidelity will be skipped (run stt-bench first)");
  const bin = ffmpegOrNull();
  fs.mkdirSync(OUT, { recursive: true });

  const voice = new AvalVoice({ key, timeoutMs: 90000 });
  const models = await voice.models();
  if (!Array.isArray(models)) {
    console.error(String(models?.error || "model list failed"));
    process.exit(2);
  }
  let cands = models.filter((m) => m.mode === "audio_speech" || (m.supported_endpoints || []).includes("/v1/audio/speech"));
  const skipped = Object.entries(SKIP).filter(([id]) => cands.some((m) => m.id === id)).map(([id, reason]) => ({ model: id, reason }));
  cands = cands.filter((m) => !SKIP[m.id]);
  const only = String(arg("models", "")).split(",").filter(Boolean);
  if (only.length) cands = cands.filter((m) => only.includes(m.id));
  console.log(`candidates: ${cands.map((m) => m.id).join(", ")}`);
  if (skipped.length) console.log(`skipped: ${skipped.map((s) => `${s.model} (${s.reason})`).join("; ")}`);
  console.log("");

  const phrases = PHRASES.slice(0, Number(arg("phrases", sttModel ? 4 : PHRASES.length)));
  const runs = [];
  // TTS is the expensive sweep, so each model is written as soon as it finishes
  // and reused on a re-run. A dropped shell must not cost the money twice.
  const PARTS = path.join(RESULTS, "tts-parts");
  fs.mkdirSync(PARTS, { recursive: true });
  const partFile = (id) => path.join(PARTS, `${id.replace(/[^\w.-]/g, "_")}.json`);
  const resume = arg("force", "0") !== "1";

  for (const m of cands) {
    if (resume && fs.existsSync(partFile(m.id))) {
      const cached = JSON.parse(fs.readFileSync(partFile(m.id), "utf8"));
      console.log(`  = ${m.id} reused (${cached.results.length} phrases)`);
      runs.push(cached);
      continue;
    }
    const owner = String(m.owned_by || "").toLowerCase();
    const per = [];
    const formatsSeen = new Set();
    // Aval audio models are rate-limited per account tier (as low as 3/min), so the
    // sweep paces itself. A 429 is an infrastructure answer, not a model verdict:
    // it is retried, and a phrase that still cannot be measured stays visible in
    // `attempts` rather than masquerading as a bad voice.
    const paceMs = Number(arg("pace", 8000));
    const sleep = () => new Promise((r) => setTimeout(r, paceMs));
    // Format support is a property of the model, not of the sentence: probing
    // wav/pcm on every phrase would spend 20+ seconds of 503 retries per phrase on
    // the ElevenLabs route. The first phrase finds the format, the rest use it.
    let chosenFormat = null;
    for (const p of phrases) {
      const res = await synthOnce(voice, { model: m.id, owner, text: p.text, formats: chosenFormat ? [chosenFormat] : ["wav", "pcm", "mp3"], tries: chosenFormat ? 3 : 2, sleep });
      if (res.ok) chosenFormat = res.format;
      const rec = {
        id: p.id,
        kind: p.kind,
        chars: p.text.length,
        ok: res.ok,
        ms: res.ms,
        error: res.error || null,
        voice: res.voice || null,
        format: res.format || null,
        attempts: res.attempts,
        limited: !res.ok && /:429/.test((res.attempts || []).join(" ")),
      };
      if (res.ok) {
        formatsSeen.add(res.format);
        const stem = `${m.id.replace(/[^\w.-]/g, "_")}-${p.id}`;
        try {
          const mp3 = path.join(OUT, `${stem}.mp3`);
          if (res.format === "mp3") {
            // the answer already is mp3: its header carries the billed duration
            fs.writeFileSync(mp3, Buffer.from(res.bytes));
          } else {
            // mp3 sibling, only to learn the true duration of the utterance
            await sleep();
            const ref = await retry(() => voice.speech({ model: m.id, input: p.text, voice: res.voice, format: "mp3" }), { tries: 2, baseMs: 20000 });
            if (ref.ok) fs.writeFileSync(mp3, Buffer.from(ref.bytes));
            else rec.ref_error = `mp3 sibling ${ref.status}`;
          }
          if (fs.existsSync(mp3)) {
            const refInfo = await probe(bin, mp3);
            rec.ref_seconds = Number.isFinite(refInfo.seconds) ? Number(refInfo.seconds.toFixed(3)) : null;
            rec.mp3 = path.relative(ROOT, mp3);
          }
          const wav = path.join(OUT, `${stem}.wav`);
          if (res.format === "wav") {
            fs.writeFileSync(wav, Buffer.from(res.bytes));
          } else if (res.format === "mp3") {
            await toWav(bin, mp3, wav, { rate: 16000, channels: 1 });
            rec.transcoded_with_ffmpeg = true;
          } else {
            // headerless PCM: prove the rate with the mp3 duration, then wrap it
            // with the bridge's own pcm16ToWav — the same code path a call uses
            const rate = detectPcmRate(res.bytes.byteLength, rec.ref_seconds);
            rec.pcm_rate = rate ? rate.rate : null;
            rec.pcm_rate_error = rate ? rate.error : null;
            fs.writeFileSync(wav, pcm16ToWav(Buffer.from(res.bytes), rate ? rate.rate : 24000));
          }
          rec.bytes = res.bytes.byteLength;
          rec.wav = path.relative(ROOT, wav);
          const info = await probe(bin, wav);
          rec.seconds = Number.isFinite(info.seconds) ? Number(info.seconds.toFixed(3)) : null;
          if (rec.ref_seconds) rec.seconds = rec.ref_seconds; // billed length, from a header that says so
          rec.rms = Number(rms(wav).toFixed(4));
          rec.silent = !rec.rms || rec.rms < 0.002;
          rec.rtf = rec.seconds ? Number((res.ms / 1000 / rec.seconds).toFixed(3)) : null;
          const price = m.pricing || {};
          rec.usd = price.output_cost_per_second ? Number((price.output_cost_per_second * (rec.seconds || 0)).toFixed(6))
            : price.input_cost_per_character ? Number((price.input_cost_per_character * p.text.length).toFixed(6)) : null;
          if (sttModel) {
            await sleep();
            const back = await retry(() => voice.transcribe({ model: sttModel, file: fs.readFileSync(wav), filename: `${p.id}.wav`, language: "fa" }), { tries: 3, baseMs: 20000 });
            rec.limited = !back.ok && (back.status === 429 || /rate.?limit/i.test(String(back.error || "")));
            rec.rt_ok = back.ok;
            rec.rt_text = back.ok ? back.text : null;
            rec.rt_error = back.ok ? null : String(back.error || "").slice(0, 160);
            rec.cer = back.ok ? Number(cer(p.text, back.text).toFixed(4)) : null;
            rec.rt_latin = back.ok ? Number(latinShare(back.text).toFixed(3)) : null;
            rec.rt_persian = back.ok ? Number(persianShare(back.text)).toFixed(3) : null;
            rec.rt_ms = back.ms;
          }
        } catch (error) {
          rec.ok = false;
          rec.error = `convert: ${String(error.message || error).slice(0, 160)}`;
        }
      }
      per.push(rec);
      console.log(`  ${(m.id + "/" + p.id).padEnd(46)} ${rec.ok ? `${String(rec.ms).padStart(5)}ms ${rec.seconds ?? "?"}s ${rec.format} rms=${rec.rms} cer=${rec.cer ?? "-"}` : `FAIL ${String(rec.error).slice(0, 60)}`}`);
    }
    const cell = { model: m.id, owner: m.owned_by, pricing: m.pricing, format: [...formatsSeen].join("+") || null, results: per };
    fs.writeFileSync(partFile(m.id), JSON.stringify(cell, null, 2));
    runs.push(cell);
  }

  const summary = runs.map((run) => {
    const ok = run.results.filter((r) => r.ok && !r.silent);
    const cerList = ok.map((r) => r.cer).filter((v) => Number.isFinite(v));
    return {
      model: run.model,
      owner: run.owner,
      formats: run.format,
      voice: ok[0]?.voice || null,
      usable: ok.length,
      attempts: run.results.length,
      any_silent: run.results.some((r) => r.silent),
      failures: run.results.filter((r) => !r.ok).map((r) => `${r.id}:${String(r.error).slice(0, 60)}`),
      ms_mean: ok.length ? Math.round(mean(ok.map((r) => r.ms))) : null,
      ms_p95: ok.length ? pctl(ok.map((r) => r.ms), 0.95) : null,
      rtf_mean: ok.length ? Number(mean(ok.map((r) => r.rtf).filter(Number.isFinite)).toFixed(3)) : null,
      cer_mean: cerList.length ? Number(mean(cerList).toFixed(4)) : null,
      cer_worst: cerList.length ? Math.max(...cerList) : null,
      latin_mean: ok.length ? Number(mean(ok.map((r) => r.rt_latin).filter(Number.isFinite)).toFixed(3)) : null,
      usd_total: Number(run.results.reduce((a, r) => a + (r.usd || 0), 0).toFixed(5)),
      usd_per_60s: run.pricing?.output_cost_per_second ? Number((run.pricing.output_cost_per_second * 60).toFixed(5)) : null,
      usd_per_1k_chars: run.pricing?.input_cost_per_character ? Number((run.pricing.input_cost_per_character * 1000).toFixed(5)) : null,
      seconds_total: Number(run.results.reduce((a, r) => a + (r.seconds || 0), 0).toFixed(2)),
    };
  });

  for (const s of summary) {
    s.pass = Boolean(s.usable === s.attempts && s.cer_mean !== null && s.cer_mean <= 0.25 && (s.latin_mean ?? 1) <= 0.05 && (s.ms_p95 ?? 1e9) <= 6000);
    s.gates = { all_ok: s.usable === s.attempts, cer: s.cer_mean !== null && s.cer_mean <= 0.25, persian: (s.latin_mean ?? 1) <= 0.05, latency: (s.ms_p95 ?? 1e9) <= 6000 };
  }
  summary.sort((a, b) => (a.cer_mean ?? 9) - (b.cer_mean ?? 9));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.mkdirSync(RESULTS, { recursive: true });
  const out = path.join(RESULTS, `tts-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({ created: new Date().toISOString(), stt_for_roundtrip: sttModel, phrases: phrases.map(({ id, kind, text }) => ({ id, kind, text })), summary, runs }, null, 2));

  console.log(`\n| model | voice | ok | round-trip CER | p95 ms | RTF | $/60s | pass |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const s of summary) {
    console.log(`| ${s.model} | ${s.voice || "-"} | ${s.usable}/${s.attempts} | ${s.cer_mean ?? "-"} | ${s.ms_p95 ?? "-"} | ${s.rtf_mean ?? "-"} | ${s.usd_per_60s ?? s.usd_per_1k_chars ?? "-"} | ${s.pass ? "PASS" : "fail"} |`);
  }
  console.log(`\nwrote ${path.relative(ROOT, out)}`);
  console.log(`audio kept in ${path.relative(ROOT, OUT)} (gitignored)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
