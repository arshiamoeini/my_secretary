// Persian speech-to-text benchmark against every transcription model Aval.ai has.
//
// Candidates are discovered live from GET /v1/models (mode === "audio_transcription"),
// not hand-picked, so the ranking covers the whole catalogue rather than a guess.
//
// Two bands are measured for every clip:
//   full   16 kHz — what a clean mic gives
//   phone  8 kHz, 300–3400 Hz — what the caller's voice actually arrives as
// The `phone` row is the one the call depends on.
//
// Scoring is CER/WER against the dataset's own transcript, on validated clips
// only; conversational clips with machine labels are reported separately as a
// domain-robustness signal. Empty output is a miss, never a zero.
//
// Usage: node bench/voice/stt-bench.mjs [--models=a,b] [--limit=8] [--bands=phone]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvalVoice, resolveKey, retry } from "./lib/api.mjs";
import { cer, containment, latinShare, wer, fold } from "./lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CORPUS = path.join(ROOT, "vendor", "voice-corpus");
const RESULTS = path.join(HERE, "results");

const COST_GATE_USD_PER_CALL = 0.05; // a 3-minute call, STT only
const CER_GATE = 0.3;
const NONEMPTY_GATE = 0.9;
const LATENCY_GATE_MS = 8000;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function mean(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN;
}
function pctl(list, q) {
  if (!list.length) return NaN;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

export async function discoverTranscriptionModels(voice) {
  const models = await voice.models();
  if (!Array.isArray(models)) return { error: String(models?.error || "model list failed") };
  return {
    models: models
      .filter((m) => m.mode === "audio_transcription" || (m.supported_endpoints || []).includes("/v1/audio/transcriptions"))
      .map((m) => ({ id: m.id, owned_by: m.owned_by, pricing: m.pricing || {}, rpm: m.max_requests_per_1_minute, min_tier: m.min_tier })),
  };
}

async function main() {
  const key = resolveKey(process.env, path.join(ROOT, "phone.config.json"));
  if (!key) {
    console.error("no Aval api key (AVAL_API_KEY or phone.config.json)");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, "manifest.json"), "utf8"));
  if (!manifest.clips?.length) {
    console.error("empty corpus — run bench/voice/corpus.mjs first");
    process.exit(2);
  }
  const limit = Number(arg("limit", manifest.clips.length));
  const bands = String(arg("bands", "full,phone")).split(",").filter(Boolean);
  const only = String(arg("models", "")).split(",").filter(Boolean);

  const voice = new AvalVoice({ key, timeoutMs: Number(arg("timeout", 90000)) });
  const found = await discoverTranscriptionModels(voice);
  if (found.error) {
    console.error(found.error);
    process.exit(2);
  }
  const candidates = only.length ? found.models.filter((m) => only.includes(m.id)) : found.models;
  const clips = manifest.clips.slice(0, limit);
  console.log(`models: ${candidates.map((c) => c.id).join(", ")}`);
  console.log(`clips: ${clips.length} (${clips.filter((c) => c.validated).length} validated), bands: ${bands.join(",")}\n`);

  // A full sweep is ~200 calls and outlives any single shell command, so every
  // (model, band) cell is written as soon as it finishes and is skipped on a
  // re-run. `--force` redoes it. This is also how a failed cell gets retried
  // without burning the whole budget again.
  const PARTS = path.join(RESULTS, "stt-parts");
  fs.mkdirSync(PARTS, { recursive: true });
  const partFile = (model, band) => path.join(PARTS, `${model.replace(/[^\w.-]/g, "_")}__${band}.json`);
  const resume = arg("force", "0") !== "1";

  const runs = [];
  for (const model of candidates) {
    for (const band of bands) {
      const cached = resume && fs.existsSync(partFile(model.id, band)) ? JSON.parse(fs.readFileSync(partFile(model.id, band), "utf8")) : null;
      if (cached) {
        console.log(`  = ${model.id}/${band} reused (${cached.results.length} clips)`);
        runs.push(cached);
        continue;
      }
      const per = [];
      for (const clip of clips) {
        const file = path.join(CORPUS, clip.files[band]);
        if (!fs.existsSync(file)) continue;
        const bytes = fs.readFileSync(file);
        const res = await retry(() => voice.transcribe({ model: model.id, file: bytes, filename: path.basename(file), language: "fa" }), { tries: Number(arg("tries", 3)), log: (m) => console.log(`  ~ ${model.id}/${band} ${m}`) });
        const text = res.ok ? res.text : "";
        const seconds = clip.seconds;
        const price = model.pricing?.input_cost_per_second ?? null;
        per.push({
          clip: clip.id,
          validated: clip.validated,
          reference: clip.reference,
          hypothesis: text,
          ok: res.ok,
          empty: res.ok ? res.empty : null,
          error: res.ok ? null : String(res.error || "").slice(0, 200),
          status: res.status,
          ms: res.ms,
          cer: res.ok ? Number(cer(clip.reference, text).toFixed(4)) : null,
          wer: res.ok ? Number(wer(clip.reference, text).toFixed(4)) : null,
          contain: res.ok ? Number(containment(clip.reference, text).toFixed(4)) : null,
          latin: res.ok ? Number(latinShare(text).toFixed(3)) : null,
          usd: price ? Number((price * seconds).toFixed(6)) : null,
          seconds,
        });
        const line = per.at(-1);
        console.log(`  ${(model.id + "/" + band).padEnd(42)} cer=${String(line.cer ?? "ERR").padEnd(7)} ${String(line.ms).padStart(5)}ms ${line.ok ? fold(line.hypothesis).slice(0, 40) : String(line.error).slice(0, 40)}`);
      }
      const cell = { model: model.id, owner: model.owned_by, band, pricing: model.pricing, results: per };
      fs.writeFileSync(partFile(model.id, band), JSON.stringify(cell, null, 2));
      runs.push(cell);
    }
  }

  const summary = runs.map((run) => {
    const ok = run.results.filter((r) => r.ok);
    const val = ok.filter((r) => r.validated);
    const conv = ok.filter((r) => !r.validated);
    const sec = run.results.reduce((a, r) => a + r.seconds, 0);
    const perMinute = run.pricing?.input_cost_per_second ? run.pricing.input_cost_per_second * 180 : null;
    return {
      model: run.model,
      band: run.band,
      calls: run.results.length,
      http_ok: ok.length,
      nonempty: val.length ? val.filter((r) => !r.empty).length / val.length : 0,
      cer_mean: val.length ? Number(mean(val.map((r) => r.cer).filter(Number.isFinite)).toFixed(4)) : null,
      cer_worst: val.length ? Math.max(...val.map((r) => r.cer || 0)) : null,
      wer_mean: val.length ? Number(mean(val.map((r) => r.wer).filter(Number.isFinite)).toFixed(4)) : null,
      contain_mean: val.length ? Number(mean(val.map((r) => r.contain).filter(Number.isFinite)).toFixed(3)) : null,
      latin_mean: val.length ? Number(mean(val.map((r) => r.latin).filter(Number.isFinite)).toFixed(3)) : null,
      cer_conversational: conv.length ? Number(mean(conv.map((r) => r.cer).filter(Number.isFinite)).toFixed(4)) : null,
      ms_mean: ok.length ? Math.round(mean(ok.map((r) => r.ms))) : null,
      ms_p95: ok.length ? pctl(ok.map((r) => r.ms), 0.95) : null,
      usd_per_3min_call: perMinute ? Number(perMinute.toFixed(5)) : null,
      usd_observed: Number(run.results.reduce((a, r) => a + (r.usd || 0), 0).toFixed(5)),
      errors: run.results.filter((r) => !r.ok).map((r) => `${r.status}:${r.error}`)[0] || null,
    };
  });

  for (const s of summary) {
    const pass = s.http_ok === s.calls && s.nonempty >= NONEMPTY_GATE && s.cer_mean !== null && s.cer_mean <= CER_GATE && s.ms_p95 <= LATENCY_GATE_MS && (s.usd_per_3min_call ?? 0) <= COST_GATE_USD_PER_CALL;
    s.pass = Boolean(pass);
    s.gates = {
      cer: s.cer_mean !== null && s.cer_mean <= CER_GATE,
      nonempty: s.nonempty >= NONEMPTY_GATE,
      latency: s.ms_p95 <= LATENCY_GATE_MS,
      cost: (s.usd_per_3min_call ?? 0) <= COST_GATE_USD_PER_CALL,
      http: s.http_ok === s.calls,
    };
  }
  summary.sort((a, b) => (a.band === b.band ? (a.cer_mean ?? 9) - (b.cer_mean ?? 9) : a.band < b.band ? -1 : 1));

  fs.mkdirSync(RESULTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(RESULTS, `stt-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({ created: new Date().toISOString(), gates: { CER_GATE, NONEMPTY_GATE, LATENCY_GATE_MS, COST_GATE_USD_PER_CALL }, corpus: { clips: clips.length, manifest: path.relative(ROOT, path.join(CORPUS, "manifest.json")) }, summary, runs }, null, 2));

  console.log(`\n| model | band | CER | WER | non-empty | p95 ms | $/3min | pass |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const s of summary) {
    console.log(`| ${s.model} | ${s.band} | ${s.cer_mean ?? "-"} | ${s.wer_mean ?? "-"} | ${(s.nonempty * 100).toFixed(0)}% | ${s.ms_p95 ?? "-"} | ${s.usd_per_3min_call ?? "-"} | ${s.pass ? "PASS" : "fail"} |`);
  }
  console.log(`\nwrote ${path.relative(ROOT, out)}`);
  if (!fs.existsSync(out)) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
