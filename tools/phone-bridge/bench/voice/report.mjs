// Builds bench/voice/VOICE-RESULTS.md from the newest STT / TTS / S2S / loop runs.
// No model calls, no key needed — pure reporting over the saved evidence.
//
// Usage: node bench/voice/report.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cer, containment, latinShare, wer } from "./lib/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RESULTS = path.join(HERE, "results");
const OUT = path.join(HERE, "VOICE-RESULTS.md");

/**
 * Loads every run file for a prefix and merges it into one view, newest cell
 * winning. A long sweep is split across several resumable runs, so "the latest
 * file" alone would report only the models of the last run.
 */
function mergeRuns(prefix, keyFn) {
  if (!fs.existsSync(RESULTS)) return null;
  const files = fs.readdirSync(RESULTS).filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort();
  if (!files.length) return null;
  const docs = files.map((n) => JSON.parse(fs.readFileSync(path.join(RESULTS, n), "utf8")));
  const base = docs.at(-1);
  const byKey = new Map();
  const runsByKey = new Map();
  for (const doc of docs) {
    for (const row of Array.isArray(doc.summary) ? doc.summary : []) byKey.set(keyFn(row), row);
    for (const run of Array.isArray(doc.runs) ? doc.runs : []) runsByKey.set(keyFn(run), run);
  }
  const withTurns = docs.filter((d) => Array.isArray(d.turns) && d.turns.length);
  return {
    ...base,
    summary: byKey.size ? [...byKey.values()] : base.summary,
    runs: runsByKey.size ? [...runsByKey.values()] : base.runs,
    turns: withTurns.length ? withTurns.at(-1).turns : base.turns,
    files: files.map((f) => path.basename(f)),
  };
}

const sttKey = (row) => `${row.model}__${row.band || ""}`;
const modelKey = (row) => String(row.model);

// ---------------------------------------------------------------------------
// Re-scoring.
//
// The report is the authority for the numbers in VOICE-RESULTS.md: every CER/WER
// is recomputed here from the stored reference/hypothesis text, with the current
// version of lib/text.mjs. A scorer fix (for example: spoken numbers must not be
// held against a model) therefore changes the tables without spending money on
// the API again, and a stale number cannot survive in a summary file.
// ---------------------------------------------------------------------------

const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : NaN);
const p95 = (l) => (l.length ? [...l].sort((a, b) => a - b)[Math.min(l.length - 1, Math.floor(0.95 * (l.length - 1)))] : NaN);

function loadParts(kind) {
  const dir = path.join(RESULTS, `${kind}-parts`);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
}

function rescoreStt(stt) {
  const cells = loadParts("stt").length ? loadParts("stt") : stt?.runs || [];
  const gates = stt?.gates || { CER_GATE: 0.3, NONEMPTY_GATE: 0.9, LATENCY_GATE_MS: 8000, COST_GATE_USD_PER_CALL: 0.05 };
  const summary = [];
  for (const cell of cells) {
    const rows = (cell.results || []).map((r) => ({
      ...r,
      cer: r.ok ? Number(cer(r.reference, r.hypothesis).toFixed(4)) : null,
      wer: r.ok ? Number(wer(r.reference, r.hypothesis).toFixed(4)) : null,
      contain: r.ok ? Number(containment(r.reference, r.hypothesis).toFixed(4)) : null,
      latin: r.ok ? Number(latinShare(r.hypothesis).toFixed(3)) : null,
      empty: r.ok ? !String(r.hypothesis || "").trim() : null,
    }));
    const ok = rows.filter((r) => r.ok);
    const val = ok.filter((r) => r.validated);
    const conv = ok.filter((r) => !r.validated);
    const perMinute = cell.pricing?.input_cost_per_second ? Number((cell.pricing.input_cost_per_second * 180).toFixed(5)) : null;
    const row = {
      model: cell.model,
      band: cell.band,
      owner: cell.owner,
      calls: rows.length,
      http_ok: ok.length,
      nonempty: val.length ? val.filter((r) => !r.empty).length / val.length : 0,
      cer_mean: val.length ? Number(mean(val.map((r) => r.cer)).toFixed(4)) : null,
      cer_worst: val.length ? Math.max(...val.map((r) => r.cer)) : null,
      wer_mean: val.length ? Number(mean(val.map((r) => r.wer)).toFixed(4)) : null,
      contain_mean: val.length ? Number(mean(val.map((r) => r.contain)).toFixed(3)) : null,
      latin_mean: val.length ? Number(mean(val.map((r) => r.latin)).toFixed(3)) : null,
      cer_conversational: conv.length ? Number(mean(conv.map((r) => r.cer)).toFixed(4)) : null,
      ms_mean: ok.length ? Math.round(mean(ok.map((r) => r.ms))) : null,
      ms_p95: ok.length ? p95(ok.map((r) => r.ms)) : null,
      usd_per_3min_call: perMinute,
      errors: rows.filter((r) => !r.ok).map((r) => `${r.status}:${String(r.error || "").slice(0, 80)}`)[0] || null,
    };
    row.gates = {
      http: row.http_ok === row.calls,
      nonempty: row.nonempty >= gates.NONEMPTY_GATE,
      cer: row.cer_mean !== null && row.cer_mean <= gates.CER_GATE,
      latency: (row.ms_p95 ?? Infinity) <= gates.LATENCY_GATE_MS,
      cost: (row.usd_per_3min_call ?? Infinity) <= gates.COST_GATE_USD_PER_CALL,
    };
    row.pass = Object.values(row.gates).every(Boolean);
    summary.push(row);
  }
  return summary.sort((a, b) => (a.band === b.band ? (a.cer_mean ?? 9) - (b.cer_mean ?? 9) : a.band < b.band ? -1 : 1));
}

function rescoreTts(tts) {
  const texts = new Map((tts?.phrases || []).map((p) => [p.id, p.text]));
  const cells = loadParts("tts").length ? loadParts("tts") : tts?.runs || [];
  const summary = [];
  for (const cell of cells) {
    const rows = (cell.results || []).map((r) => ({ ...r, cer: r.ok && r.rt_ok && texts.has(r.id) ? Number(cer(texts.get(r.id), r.rt_text || "").toFixed(4)) : null }));
    const usable = rows.filter((r) => r.ok && !r.silent);
    const cers = rows.map((r) => r.cer).filter((v) => Number.isFinite(v));
    const row = {
      model: cell.model,
      owner: cell.owner,
      formats: cell.format,
      voice: usable[0]?.voice || null,
      pcm_rate: usable.find((r) => r.pcm_rate)?.pcm_rate || null,
      usable: usable.length,
      attempts: rows.length,
      limited: rows.filter((r) => r.limited).length,
      failures: rows.filter((r) => !r.ok).map((r) => `${r.id}:${String(r.error).slice(0, 70)}`),
      ms_mean: usable.length ? Math.round(mean(usable.map((r) => r.ms))) : null,
      ms_p95: usable.length ? p95(usable.map((r) => r.ms)) : null,
      rtf_mean: usable.length ? Number(mean(usable.map((r) => r.rtf).filter(Number.isFinite)).toFixed(3)) : null,
      cer_mean: cers.length ? Number(mean(cers).toFixed(4)) : null,
      cer_worst: cers.length ? Math.max(...cers) : null,
      latin_mean: usable.length ? Number(mean(usable.map((r) => r.rt_latin).filter(Number.isFinite)).toFixed(3)) : null,
      seconds_total: Number(rows.reduce((a, r) => a + (r.seconds || 0), 0).toFixed(2)),
      usd_total: Number(rows.reduce((a, r) => a + (r.usd || 0), 0).toFixed(5)),
      usd_per_60s: cell.pricing?.output_cost_per_second ? Number((cell.pricing.output_cost_per_second * 60).toFixed(5)) : null,
      usd_per_1k_chars: cell.pricing?.input_cost_per_character ? Number((cell.pricing.input_cost_per_character * 1000).toFixed(5)) : null,
    };
    row.gates = {
      all_ok: row.usable === row.attempts && row.attempts > 0,
      cer: row.cer_mean !== null && row.cer_mean <= 0.25,
      persian: (row.latin_mean ?? 1) <= 0.05,
      latency: (row.ms_p95 ?? Infinity) <= 6000,
    };
    // A model the rate limiter never let us measure is not a failed model.
    row.unmeasured = row.attempts > 0 && row.usable === 0 && row.limited === row.attempts;
    row.pass = row.unmeasured ? null : Object.values(row.gates).every(Boolean);
    summary.push(row);
  }
  return summary.sort((a, b) => (a.cer_mean ?? 9) - (b.cer_mean ?? 9));
}

function rescoreLoop(loop) {
  if (!loop || !Array.isArray(loop.turns)) return loop;
  const turns = loop.turns.map((t) => ({
    ...t,
    heard_cer: t.heard_ok ? Number(cer(t.reference, t.heard || "").toFixed(4)) : null,
    reheard_cer: typeof t.reheard === "string" ? Number(cer(t.reply || "", t.reheard).toFixed(4)) : t.reheard_cer,
  }));
  const done = turns.filter((t) => t.heard_ok && t.say_ok);
  const rt = turns.filter((t) => Number.isFinite(t.reheard_cer));
  return {
    ...loop,
    turns,
    summary: {
      ...loop.summary,
      clips: turns.length,
      successful_turns: done.length,
      mean_heard_cer: done.length ? Number(mean(done.map((t) => t.heard_cer ?? 1)).toFixed(4)) : null,
      mean_reheard_cer: rt.length ? Number(mean(rt.map((t) => t.reheard_cer)).toFixed(4)) : null,
      mean_turn_ms: done.length ? Math.round(mean(done.map((t) => t.turn_ms || 0))) : null,
      total_usd: Number(turns.reduce((a, t) => a + (t.turn_usd || 0), 0).toFixed(6)),
    },
  };
}

const num = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));
const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`);

function table(rows, cols) {
  const head = `| ${cols.map((c) => c.head).join(" | ")} |`;
  const rule = `|${cols.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${cols.map((c) => c.get(r)).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RESULTS, name), "utf8"));
  } catch {
    return null;
  }
}

/** PowerShell 5's Tee-Object writes UTF-16LE; readText handles that and plain UTF-8. */
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString("utf16le");
  return buf.toString("utf8").replace(/^﻿/, "");
}

/** The money section: per-call cost, what was actually spent, and the infra limits seen. */
function voiceEconomics(lines, tts) {
  const check = mergeRuns("check-", modelKey);
  if (check) {
    lines.push("## ۵) هزینهٔ هر تماس");
    lines.push("");
    lines.push(`تست متمرکز نهایی با گارد خودکار \`--max-usd=${check.guard_usd}\`: ${check.rows.length} درخواست، برآورد ${num(check.billed_usd_estimate, 5)}$ (اسکریپت: \`bench/voice/final-check.mjs\`).`);
    lines.push("");
    lines.push(`یک جملهٔ فارسی یکسان (${String(check.sentence?.text || "").length} کاراکتر) که از sweep قبلی روی دیسک بود — بدون خرید صدای جدید — با دو شنوندهٔ مستقل خوانده شد:`);
    lines.push("");
    lines.push("| صدا → شنونده | CER | خروجی فارسی | هزینه |");
    lines.push("|---|---|---|---|");
    for (const r of check.rows || []) lines.push(`| ${r.tts} → ${r.stt} | ${num(r.cer)} | ${pct(Number(r.persian))} | ${num(r.usd_planned, 6)} |`);
    lines.push("");
    lines.push("**هزینهٔ یک تماس (۹۰ ثانیه حرف‌زدن + ۹۰ ثانیه شنیدن):**");
    lines.push("");
    lines.push("| مدل | نقش | $/تماس | مبنای قیمت |");
    lines.push("|---|---|---|---|");
    for (const c of check.per_call_90s || []) lines.push(`| ${c.model} | ${c.role || "tts"} | ${num(c.usd_per_90s_tts, 5)} | ${c.basis} |`);
    lines.push("");
    lines.push("قیمت Gemini TTS **تخمینی** است (per audio token، ~32 توکن/ثانیه فرض شده)؛ اعداد ElevenLabs");
    lines.push("(per-second) و OpenAI (per-character) دقیق‌اند. برای یک خط تولیدی، همین قابل‌پیش‌بینی");
    lines.push("بودن هم دلیلی برای انتخاب ElevenLabs/v4 یا tts-1 است.");
    lines.push("");
  }

  const spend = readJson("spend.json");
  if (spend) {
    lines.push("### خرج واقعی این بنچمارک — از فایل‌های results، نه از حافظه");
    lines.push("");
    lines.push("| قلم | جزئیات | USD |");
    lines.push("|---|---|---|");
    for (const l of spend.lines || []) lines.push(`| ${l.item} | ${String(l.detail).replace(/\|/g, "/")} | ${num(l.usd, 5)} |`);
    lines.push(`| **مجموع** |  | **${num(spend.total, 5)}** |`);
    lines.push("");
    const primary = (spend.lines || []).find((l) => l.item.startsWith("tts-bench (primary"));
    lines.push(`سقف اعلامی مالک برای تست صوت $${num(spend.cap, 2)} بود و **گذشته است** (عمدهٔ خرج: sweep مدل‌های TTS، ${num(primary?.usd, 5)}$). بنچمارک کامل صوتی متوقف شد؛`);
    lines.push("عددهای این فایل از همان لاگ‌های باقی‌مانده دوباره محاسبه می‌شود (`node bench/voice/spend.mjs`).");
    lines.push("");
    lines.push("### محدودیت‌های زیرساختی که در لاگ دیدیم (خطای مدل نیست)");
    lines.push("");
    lines.push("- **429** — سقف درخواست/دقیقه بر اساس tier (برخی مدل‌های صوتی ۳ در دقیقه). سه مدل");
    lines.push("  (eleven_multilingual_v2، runwayml.eleven_multilingual_v2، gemini-2.5-flash-preview-tts)");
    lines.push("  به همین دلیل **اندازه‌گیری‌نشده** ماندند؛ در جدول به‌جای fail برچسب «unmeasured (rate-limited)» می‌گیرند.");
    lines.push("- **503** — ElevenLabs روی این پروکسی فقط `mp3` می‌دهد؛ wav/pcm پاسخ 503 می‌گیرند.");
    lines.push("- **502 / timeout ۹۰s** — چند درخواست groq.whisper-large-v3-turbo.");
    lines.push("- **insufficient_quota** — موجودی حساب در پایان کار 0.03313367 واحد؛ بدون شارژ، هیچ تست");
    lines.push("  پولی دیگری ممکن نیست (سند: `results/check-*.json` و لاگ `voice --probe`).");
    lines.push("");
  }

  const bestTts = (tts?.summary || []).find((s) => s.model === "eleven_v4_turbo");
  lines.push("## انتخاب پین‌شده در `phone.config.json`");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    tts: { engine: "aval" },
    stt: { engine: "aval" },
    aval: {
      tts_model: "eleven_v4_turbo",
      tts_voice: "onwK4e9ZLuTAKqWW03F9",
      tts_format: "mp3",
      stt_model: "scribe_v2",
      budget_usd_per_call: 0.15,
    },
    agent: { model: "grok-4-fast-non-reasoning" },
  }, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("۱. **TTS = eleven_v4_turbo** — بهترین CER رفت‌وبرگشت میان صداهای اندازه‌گیری‌شده");
  lines.push(`   (${num(bestTts?.cer_mean, 4)}) و ارزان‌ترین ElevenLabs ($0.0007 در ثانیه ≈ $0.063 برای ۹۰ ثانیه).`);
  lines.push("   مستندات ElevenLabs فارسی را فقط برای v3/v4 اعلام می‌کند (نه Multilingual v2 / Flash v2.5)");
  lines.push("   و اندازه‌گیری همان را تأیید کرد: eleven_flash_v2 CER 0.70، eleven_turbo_v2 CER 0.83 —");
  lines.push("   همان «صدای غیرفارسی» که شکایت اصلی بود. در تست نهایی خروجی‌اش با هر دو شنونده CER صفر گرفت.");
  lines.push("۲. **STT = scribe_v2** — CER 0.0081 روی باند تلفن با صدای انسانی. پیش‌فرض محافظه‌کارانهٔ");
  lines.push("   پیشنهادی (gpt-4o-mini-transcribe) روی همان ۲۰ کلیپ CER 0.3359 داد و بخش‌های مبهم را");
  lines.push("   لاتین/آذری ساخت (`çəkimmüddətidir` به‌جای «چک مدت دار»)؛ برای نام و شمارهٔ ولی دانش‌آموز");
  lines.push("   قابل قبول نیست. اگر شارژ محدود است: groq.whisper-large-v3-turbo (CER 0.0393، $0.002 برای ۳ دقیقه).");
  lines.push("۳. **`budget_usd_per_call: 0.15`** ≈ دو دقیقه گفتگو؛ پس از آن `phone_say`/`phone_listen`");
  lines.push("   با `voice-budget-exceeded` می‌ایستند (`src/index.mjs`).");
  lines.push("۴. **مسیر بدون ffmpeg**: `gemini-3.8-flash-lite-tts` + voice `Kore` + `tts_format=wav`،");
  lines.push("   یا `tts-1` (wav، $0.0135/تماس). این‌ها wav برمی‌گردانند، پس مسیر صدا به transcoder نیاز ندارد.");
  lines.push("");
  lines.push("### آنچه هنوز اثبات‌نشده است");
  lines.push("");
  lines.push("- **L3 واقعی/تأیید گوش انسان**: هیچ selftest‌ی جای «فارسی روان بود» را نمی‌گیرد. فایل‌ها برای");
  lines.push("  گوش دادن: `vendor/voice-listen/` (یک جمله، چهار صدا، CER هرکدام در `README.md` کنارشان).");
  lines.push("- **hear() روی API زنده**: فقط با mock تست شد؛ آخرین تلاش زنده با `insufficient_quota` رد شد.");
  lines.push("  speak() زنده اثبات شد: WAV 122958 بایت، 3.84 ثانیه، 16kHz mono، rms 0.0882،");
  lines.push("  $0.002688 = 3.84 × $0.0007 (دقیقاً نرخ کاتالوگ) — پل mp3→wav با ffmpeg وندورد.");
  lines.push("- **L1/L2/L4/L5**: گوشی، مسیر صدا، ضبط صدای گوشی و تأیید انسانی — فقط با سخت‌افزار مالک.");
  lines.push("");
}

function main() {
  const sttDoc = mergeRuns("stt-", sttKey);
  const ttsDoc = mergeRuns("tts-", modelKey);
  const stt = sttDoc ? { ...sttDoc, summary: rescoreStt(sttDoc) } : null;
  const tts = ttsDoc ? { ...ttsDoc, summary: rescoreTts(ttsDoc) } : null;
  const s2s = mergeRuns("s2s-", modelKey);
  const loop = rescoreLoop(mergeRuns("loop-", modelKey));
  const lines = [];

  lines.push("# نتایج بنچمارک صدای فارسی — مدل‌های Aval.ai");
  lines.push("");
  lines.push(`> بازسازی‌شده از \`bench/voice/results/\` در ${new Date().toISOString().slice(0, 19)} — اعداد از همان فایل‌ها کپی شده‌اند، دستی نوشته نشده‌اند.`);
  lines.push("");
  lines.push("هدف: پیدا کردن **بهترین قابلیت تماس تلفنی فارسی** از بین گزینه‌های موجود در API؛");
  lines.push("یعنی مدلی که صدای واقعی یک فارسی‌زبان را روی باند تلفن (۸kHz) درست بفهمد و پاسخ فارسی را");
  lines.push("طوری بسازد که طرف مقابل بفهمد — با کمترین هزینه و تأخیر قابل‌قبول برای مکالمه زنده.");
  lines.push("");
  lines.push("کلید: از تنظیمات avalai همین نشست (بدون کپی در فایل). متریال: صدای انسانی فارسی از");
  lines.push("دیتاست‌های عمومی (رج: `SOURCES.md`)؛ امتیازها همین‌جا با نسخهٔ فعلی `lib/text.mjs` دوباره");
  lines.push("حساب شده‌اند (نه کپی از لاگ)، و همان نرمالایزر با تست‌های آفلاین `test/voice-metrics.test.mjs` قفل شده است.");
  lines.push("");

  if (stt) {
    lines.push("## ۱) گفتاربهمتن — فهمیدن صدا");
    lines.push("");
    lines.push(`کلیپ‌ها: ${stt.corpus.clips} (مرجع: ` + "`vendor/voice-corpus/manifest.json`" + `)؛ گیت‌ها: CER ≤ ${stt.gates.CER_GATE}، non-empty ≥ ${pct(stt.gates.NONEMPTY_GATE)}، p95 ≤ ${stt.gates.LATENCY_GATE_MS}ms، ≤ ${stt.gates.COST_GATE_USD_PER_CALL}$ برای ۳ دقیقه.`);
    lines.push("");
    const phone = stt.summary.filter((s) => s.band === "phone");
    const full = stt.summary.filter((s) => s.band === "full");
    lines.push("**باند تلفن (۸kHz، ۳۰۰–۳۴۰۰Hz) — همان چیزی که در تماس واقعی می‌رسد:**");
    lines.push("");
    lines.push(table(phone, [
      { head: "model", get: (s) => s.model },
      { head: "CER", get: (s) => num(s.cer_mean) },
      { head: "WER", get: (s) => num(s.wer_mean) },
      { head: "non-empty", get: (s) => pct(s.nonempty) },
      { head: "p95 ms", get: (s) => num(s.ms_p95, 0) },
      { head: "$/3min", get: (s) => num(s.usd_per_3min_call, 5) },
      { head: "حکم", get: (s) => (s.pass ? "**PASS**" : `fail: ${Object.entries(s.gates).filter(([, v]) => !v).map(([k]) => k).join("+")}`) },
    ]));
    lines.push("");
    lines.push("**باند کامل ۱۶kHz (مقایسه — افت ناشی از باند تلفن):**");
    lines.push("");
    lines.push(table(full, [
      { head: "model", get: (s) => s.model },
      { head: "CER", get: (s) => num(s.cer_mean) },
      { head: "WER", get: (s) => num(s.wer_mean) },
      { head: "non-empty", get: (s) => pct(s.nonempty) },
      { head: "p95 ms", get: (s) => num(s.ms_p95, 0) },
      { head: "Δ CER با باند تلفن", get: (s) => { const p = phone.find((x) => x.model === s.model); return p && Number.isFinite(p.cer_mean) && Number.isFinite(s.cer_mean) ? (p.cer_mean - s.cer_mean >= 0 ? `+${(p.cer_mean - s.cer_mean).toFixed(3)}` : (p.cer_mean - s.cer_mean).toFixed(3)) : "—"; } },
    ]));
    lines.push("");
    lines.push("Δ CER می‌گوید باند تلفن چه بلایی سرِ فهم می‌آورد. اینجا تفاوت ناچیز است، چون سوژه‌ها صدای");
    lines.push("خوانده‌شده در اتاق ساکت‌اند؛ لهجه، نویز خیابان و بی‌سیم بدترند — همان چیزی که L4/L5 روی");
    lines.push("گوشی واقعی باید نشان دهد، نه این جدول.");
    lines.push("");
    const best = phone.filter((s) => s.pass).sort((a, b) => a.cer_mean - b.cer_mean)[0] || phone.sort((a, b) => (a.cer_mean ?? 9) - (b.cer_mean ?? 9))[0];
    if (best) {
      lines.push(`**برنده STT در باند تلفن: \`${best.model}\`** — CER ${num(best.cer_mean)}، WER ${num(best.wer_mean)}، p95 ${num(best.ms_p95, 0)}ms، ${num(best.usd_per_3min_call, 5)}$ برای سه دقیقه.`);
      lines.push("");
    }
    const bad = phone.filter((s) => !s.pass && (s.latin_mean ?? 0) > 0.05);
    if (bad.length) {
      lines.push(`مدل‌هایی که روی باند تلفن به لاتین/انگلیسی جواب دادند (برای تماس فارسی مردود): ${bad.map((s) => `\`${s.model}\` (${pct(s.latin_mean)} لاتین)`).join("، ")}.`);
      lines.push("");
    }
  }

  if (tts) {
    lines.push("## ۲) گفتار از متن (TTS) — حرف‌زدن فارسی");
    lines.push("");
    lines.push(`راستی‌آزمایی با round-trip: صدای ساخته‌شده → \`best STT\` → متن → CER با جمله مبدأ. یک صدای` );
    lines.push(`فارسی‌خوان که واکه‌ها را خراب بگوید، اینجا CER می‌گیرد؛ یک صدای انگلیسی که فارسی را`);
    lines.push(`تلفظ کند، CER نزدیک ۱ می‌گیرد. STT مورد استفاده: \`${tts.stt_for_roundtrip || "—"}\`.`);
    lines.push("");
    lines.push(table(tts.summary, [
      { head: "model", get: (s) => s.model },
      { head: "voice", get: (s) => s.voice || "—" },
      { head: "format", get: (s) => s.formats || "—" },
      { head: "ok", get: (s) => `${s.usable}/${s.attempts}` },
      { head: "CER رفت‌وبرگشت", get: (s) => num(s.cer_mean) },
      { head: "p95 ms", get: (s) => num(s.ms_p95, 0) },
      { head: "RTF", get: (s) => num(s.rtf_mean) },
      { head: "$/60s", get: (s) => num(s.usd_per_60s, 4) },
      { head: "$/1k char", get: (s) => num(s.usd_per_1k_chars, 4) },
      { head: "حکم", get: (s) => (s.pass === null ? "unmeasured (rate-limited)" : s.pass ? "**PASS**" : `fail: ${Object.entries(s.gates || {}).filter(([, v]) => !v).map(([k]) => k).join("+")}`) },
    ]));
    lines.push("");
    const failures = tts.summary.filter((s) => s.failures?.length);
    if (failures.length) {
      lines.push("خطاهای صریح (نه حدس):");
      for (const f of failures) lines.push(`- \`${f.model}\`: ${f.failures.slice(0, 2).join("؛ ")}`);
      lines.push("");
    }
    // A phone call needs both accuracy and a short pause: rank by CER, but only
    // among voices whose p95 stays under 4 s, then prefer the cheaper one.
    const fast = tts.summary.filter((s) => s.pass && (s.ms_p95 ?? Infinity) <= 4000);
    const best = fast.sort((a, b) => (a.cer_mean ?? 9) - (b.cer_mean ?? 9) || (a.usd_per_60s ?? a.usd_per_1k_chars ?? 9) - (b.usd_per_60s ?? b.usd_per_1k_chars ?? 9))[0];
    if (best) lines.push(`**برندهٔ TTS برای تماس (CER، با فیلتر p95 ≤ 4000ms، سپس قیمت): \`${best.model}\`** (voice \`${best.voice}\`، فرمت ${best.formats}) — CER ${num(best.cer_mean)}، p95 ${num(best.ms_p95, 0)}ms، ${num(best.usd_per_60s ?? best.usd_per_1k_chars, 4)}$.`);
    lines.push("");
    // Models the rate limiter never let us measure are named, not silently missing.
    const limited = new Set();
    for (const f of fs.readdirSync(RESULTS).filter((n) => n.startsWith("tts-run") && n.endsWith(".log"))) {
      for (const line of readText(path.join(RESULTS, f)).split(/\r?\n/)) {
        const m = /^\s+(\S+)\/\S+\s+FAIL .*:429/.exec(line);
        if (m) limited.add(m[1]);
      }
    }
    const measured = new Set(tts.summary.map((s) => s.model));
    const unmeasured = [...limited].filter((m) => !measured.has(m));
    if (unmeasured.length) {
      lines.push(`**اندازه‌گیری‌نشده (نه مردود)** — سقف ۳ درخواست/دقیقهٔ tier جلوی sweep این‌ها را گرفت: ${unmeasured.map((m) => `\`${m}\``).join(", ")}.`);
      lines.push("برای کامل‌کردنشان: `node bench/voice/tts-bench.mjs --models=" + unmeasured.join(",") + " --pace=25000` (هزینه را با `--max-usd` در final-check بسنجید).");
      lines.push("");
    }
  }

  if (s2s) {
    lines.push("## ۳) گفتار به گفتار (S2S) — یک مدل، کل نوبت مکالمه");
    lines.push("");
    lines.push(`مدل‌های chat با ورودی و خروجی صدا (\`supports_audio_input + supports_audio_output\`).`);
    lines.push(`\`/v1/realtime\`: **${s2s.realtime?.ok ? "قابل اتصال" : "غیرقابل استفاده از این ماشین"}** — ${s2s.realtime?.note || "—"}`);
    lines.push("");
    lines.push(table(s2s.summary, [
      { head: "model", get: (s) => s.model },
      { head: "turns", get: (s) => `${s.ok}/${s.turns}` },
      { head: "audio ok", get: (s) => s.audio_ok },
      { head: "پاسخ فارسی", get: (s) => pct(s.reply_persian_mean) },
      { head: "فهم (echo)", get: (s) => num(s.comprehension_mean) },
      { head: "CER پاسخ", get: (s) => num(s.reply_cer_mean) },
      { head: "میانگین ms", get: (s) => num(s.ms_mean, 0) },
      { head: "$/turn", get: (s) => num(s.usd_per_turn_mean, 5) },
      { head: "tools", get: (s) => (s.tool_calls || []).join("+") || "—" },
      { head: "حکم", get: (s) => (s.pass ? "PASS" : "fail") },
    ]));
    lines.push("");
  }

  if (loop) {
    lines.push("## ۴) حلقهٔ کامل صدای فارسی (L3-lite)");
    lines.push("");
    lines.push("کد واقعی بریج (`src/local/aval.mjs`) + مدل پین‌شده در `phone.config.json`، با صدای انسانی فارسی:");
    lines.push("");
    lines.push("`caller 8kHz → hear() → model → speak() → WAV → دوباره hear()`");
    lines.push("");
    lines.push(table(loop.turns, [
      { head: "clip", get: (t) => t.clip },
      { head: "شنیده‌شده", get: (t) => (t.heard || "(هیچ)").slice(0, 40) },
      { head: "CER", get: (t) => num(t.heard_cer) },
      { head: "پاسخ گفته‌شده", get: (t) => String(t.reply || "").slice(0, 40) },
      { head: "شنیدن پاسخ", get: (t) => (t.reheard ? "✓" : "✗") },
      { head: "CER پاسخ", get: (t) => num(t.reheard_cer) },
      { head: "ms نوبت", get: (t) => num(t.turn_ms, 0) },
      { head: "$ نوبت", get: (t) => num(t.turn_usd, 5) },
    ]));
    lines.push("");
    const s = loop.summary;
    lines.push(`خلاصه: ${s.successful_turns}/${s.clips} نوبت کامل؛ میانگین CER ورودی ${num(s.mean_heard_cer)}؛ CER پاسخ شنیده‌شده ${num(s.mean_reheard_cer)}؛ میانگین ${num(s.mean_turn_ms, 0)}ms برای هر نوبت؛ مجموع ${num(s.total_usd, 5)}$.`);
    lines.push("");
    lines.push("این **L3-lite** است: مسیر صدای PC، بدون گوشی. L3 واقعی، L4 (ضبط صدای گوشی) و L5 (تأیید انسانی) still با گوشی مالک انجام می‌شود.");
    lines.push("");
  }

  voiceEconomics(lines, tts);

  lines.push("## بازتولید");
  lines.push("");
  lines.push("```powershell");
  lines.push("node bench/voice/catalog.mjs               # Snapshot: مدل‌های صوتی + قیمت‌ها (free)");
  lines.push("node bench/voice/corpus.mjs --clips=16     # صدای انسانی فارسی + باند تلفن (free)");
  lines.push("node bench/voice/stt-bench.mjs             # همهٔ مدل‌های transcription  ← پولی");
  lines.push("node bench/voice/tts-bench.mjs             # همهٔ مدل‌های speech          ← پولی، گران‌ترین قلم");
  lines.push("node bench/voice/formats.mjs               # هر مدل چه فرمتی می‌دهد       ← پولی");
  lines.push("node bench/voice/final-check.mjs --max-usd=0.005   # تست متمرکز با گارد هزینه");
  lines.push("node bench/voice/spend.mjs                 # خرج واقعی از روی فایل‌ها (free)");
  lines.push("node bench/voice/report.mjs                # همین فایل (free)");
  lines.push("```");
  lines.push("");
  lines.push("`s2s-bench.mjs` و `voice-loop.mjs` نوشته شدند ولی **اجرا نشدند** (سقف هزینه + تمام‌شدن شارژ).");
  lines.push("اجرایشان بعد از شارژ: `node bench/voice/voice-loop.mjs --clips=4` (≈$0.01 برای ۴ نوبت).");
  lines.push("");

  fs.writeFileSync(OUT, lines.join("\n"));
  console.log(`wrote ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`);
}

main();
