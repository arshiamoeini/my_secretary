// Speech-to-speech probe: can ONE Aval model run a Persian call turn?
//
// A phone call lives or dies on turn latency: hear → think → speak. The
// transcription+TTS pipeline pays two round trips; an audio-native chat model
// (gpt-audio / gpt-audio-mini, which the catalogue says speak and listen and also
// expose /v1/realtime) could do it in one. This bench measures whether the
// shortcut actually understands Persian, or only pretends to.
//
// For each model it runs, per clip:
//   comprehension — the model's own audio transcript vs. the dataset reference (CER)
//   reply          — is the answer Persian, on-topic, and does it keep the gates?
//   voice          — the reply audio re-transcribed by the winning STT (round-trip CER)
//   tools          — a phone-tool call must still fire while audio is enabled
//   latency/cost   — whole-turn ms and the price from the usage counters
//
// Usage: node bench/voice/s2s-bench.mjs [--stt=whisper-1] [--limit=4]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvalVoice, resolveKey, retry } from "./lib/api.mjs";
import { cer, containment, latinShare, persianShare } from "./lib/text.mjs";
import { ffmpegOrNull, probe, rms, toWav } from "./lib/audio.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CORPUS = path.join(ROOT, "vendor", "voice-corpus");
const RESULTS = path.join(HERE, "results");
const OUT = path.join(ROOT, "vendor", "voice-s2s");

const SYSTEM = [
  "تو منشی تلفنی دفتر مدرسه هستی و فقط فارسی صحبت می‌کنی.",
  "در هر نوبت اول عینِ جمله‌ای که از caller شنیدی را تکرار کن («شنیدم: ...»)، بعد کوتاه جواب بده.",
  "هیچ چیزی که نشنیده‌ای را جعل نکن. اگر صدا نامفهوم بود، بگو نشنیدم و دوباره بپرس.",
  "اگر نام یا شماره شنیدی، با ابزار log_call ثبتش کن.",
].join(" ");
const TOOLS = [
  {
    type: "function",
    function: {
      name: "log_call",
      description: "ثبت نتیجه تماس در گزارش",
      parameters: { type: "object", properties: { summary: { type: "string" }, phone: { type: "string" } }, required: ["summary"] },
    },
  },
];

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}
const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : NaN);

function usageCost(usage = {}, pricing = {}) {
  if (!usage || !pricing) return null;
  const per = (tokens, rate) => ((Number(tokens) || 0) * (Number(rate) || 0)) / 1e6;
  // OpenAI-style usage nests the audio counters under *_tokens_details
  const details = usage.prompt_tokens_details || {};
  const outDetails = usage.completion_tokens_details || {};
  const audioIn = usage.input_audio_tokens ?? details.input_audio_tokens ?? 0;
  const audioOut = usage.audio_tokens ?? outDetails.audio_tokens ?? 0;
  const textIn = Math.max(0, (usage.prompt_tokens || 0) - audioIn);
  const textOut = Math.max(0, (usage.completion_tokens || 0) - audioOut);
  const total = per(textIn, pricing.input) + per(audioIn, pricing.audio_input) + per(textOut, pricing.output) + per(audioOut, pricing.audio_output);
  return Number(total.toFixed(6));
}

async function realtimeProbe(key) {
  try {
    const ws = new WebSocket(`wss://api.avalai.ir/v1/realtime?model=gpt-audio-mini`, { headers: { Authorization: `Bearer ${key}` } });
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve({ ok: false, note: "no handshake within 12s" });
      }, 12000);
      const done = (value) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(value);
      };
      ws.addEventListener("open", () => done({ ok: true, note: "handshake open" }));
      ws.addEventListener("error", (ev) => done({ ok: false, note: `error: ${ev?.message || ev?.type || "unknown"}` }));
      ws.addEventListener("close", (ev) => done({ ok: false, note: `closed code=${ev?.code ?? "?"}` }));
    });
  } catch (error) {
    return { ok: false, note: `cannot open: ${String(error?.message || error)}` };
  }
}

async function main() {
  const key = resolveKey(process.env, path.join(ROOT, "phone.config.json"));
  if (!key) {
    console.error("no Aval api key");
    process.exit(2);
  }
  const sttModel = String(arg("stt", ""));
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, "manifest.json"), "utf8"));
  const limit = Number(arg("limit", 4));
  const clips = manifest.clips.filter((c) => c.validated && c.words >= 6).slice(0, limit);
  const bin = ffmpegOrNull();
  fs.mkdirSync(OUT, { recursive: true });

  const voice = new AvalVoice({ key, timeoutMs: 120000 });
  const catalog = await voice.models();
  const models = (Array.isArray(catalog) ? catalog : []).filter((m) => m.supports_audio_output && m.supports_audio_input);
  console.log(`audio chat models: ${models.map((m) => m.id).join(", ")}\n`);

  const runs = [];
  // Aval applies per-tier rate limits to audio models (sometimes 3/min), so the
  // sweep paces itself; a 429 that survives the retries is stored as `limited`
  // and reported as unmeasured instead of as a bad model.
  const paceMs = Number(arg("pace", 12000));
  const sleep = () => new Promise((r) => setTimeout(r, paceMs));
  for (const m of models) {
    const per = [];
    for (const clip of clips) {
      await sleep();
      const wav = fs.readFileSync(path.join(CORPUS, clip.files.phone));
      const b64 = wav.toString("base64");
      const started = Date.now();
      const res = await retry(
        () =>
          voice.chatAudio({
            model: m.id,
            voice: "alloy",
            format: "wav",
            maxTokens: 300,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: [{ type: "text", text: "تماس گرفته شده. اول جمله‌ای که می‌شنوی را عیناً تکرار کن، بعد به آن فارسی پاسخ بده." }] },
              { role: "user", content: [{ type: "input_audio", input_audio: { data: b64, format: "wav" } }] },
            ],
          }),
        { tries: 3, baseMs: 20000 },
      );
      const rec = { clip: clip.id, ms: Date.now() - started, ok: res.ok, status: res.status, limited: !res.ok && (res.status === 429 || /rate.?limit/i.test(String(res.error || ""))), error: res.ok ? null : String(res.error || "").slice(0, 200) };
      if (res.ok) {
        const audio = res.audioB64 ? Buffer.from(res.audioB64, "base64") : Buffer.alloc(0);
        rec.text = res.text || "";
        rec.has_audio = audio.length > 1000;
        rec.audio_bytes = audio.length;
        if (audio.length > 1000) {
          const f = path.join(OUT, `${m.id.replace(/[^\w.-]/g, "_")}-${clip.id}.wav`);
          fs.writeFileSync(f, audio);
          const p = await probe(bin, f);
          rec.audio_seconds = Number.isFinite(p.seconds) ? Number(p.seconds.toFixed(2)) : null;
          rec.audio_rms = Number(rms(f).toFixed(4));
          if (sttModel) {
            await sleep();
            const back = await retry(() => voice.transcribe({ model: sttModel, file: audio, filename: "reply.wav", language: "fa" }), { tries: 3, baseMs: 20000 });
            rec.reply_cer = back.ok ? Number(cer(rec.text || back.text, back.text).toFixed(4)) : null;
            rec.reply_text = back.ok ? back.text.slice(0, 160) : null;
            rec.reply_limited = !back.ok && (back.status === 429 || /rate.?limit/i.test(String(back.error || "")));
          }
        }
        rec.comprehension = res.text ? Number(containment(clip.reference, res.text).toFixed(3)) : null;
        rec.echo_cer = res.text ? Number(cer(clip.reference, res.text).toFixed(4)) : null;
        rec.reply_persian = Number(persianShare(res.text || "")).toFixed(2);
        rec.reply_latin = Number(latinShare(res.text || "")).toFixed(2);
        rec.usage = res.usage;
        rec.usd = usageCost(res.usage, m.pricing);
      }
      per.push(rec);
      console.log(`  ${(m.id + "/" + clip.id).padEnd(42)} ${rec.ok ? `${rec.ms}ms audio=${rec.has_audio} reply_persian=${rec.reply_persian} usd=${rec.usd}` : `FAIL ${rec.error}`}`);
    }

    // tool-call probe with the same audio turn
    await sleep();
    const toolsProbe = await retry(
      () =>
        voice.chatAudio({
          model: m.id,
          voice: "alloy",
          format: "wav",
          maxTokens: 300,
          tools: TOOLS,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: [{ type: "text", text: "اگر caller شماره یا نام گفت، ابزار log_call را صدا بزن." }] },
            { role: "user", content: [{ type: "text", text: "سلام، من پدر علی رضایی هستم، شماره من ۰۹۱۲۳۴۵۶۷۸۹." }] },
          ],
        }),
      { tries: 3, baseMs: 20000 },
    );
    const toolCalls = toolsProbe.ok ? toolsProbe.json?.choices?.[0]?.message?.tool_calls || [] : [];

    runs.push({
      model: m.id,
      owner: m.owned_by,
      pricing: m.pricing,
      endpoints: m.supported_endpoints,
      results: per,
      tool_probe: { ok: toolsProbe.ok, tool_calls: toolCalls.map((t) => t.function?.name), error: toolsProbe.error || null },
    });
  }

  const rt = realtimeProbe(key);
  console.log(`\n/v1/realtime (gpt-audio-mini): ${rt.ok ? "reachable" : "not usable"} — ${rt.note}`);

  const summary = runs.map((r) => {
    const ok = r.results.filter((x) => x.ok);
    return {
      model: r.model,
      turns: r.results.length,
      ok: ok.length,
      ms_mean: ok.length ? Math.round(mean(ok.map((x) => x.ms))) : null,
      audio_ok: ok.filter((x) => x.has_audio && (x.audio_rms ?? 0) > 0.002).length,
      reply_persian_mean: ok.length ? Number(mean(ok.map((x) => Number(x.reply_persian)).filter(Number.isFinite)).toFixed(2)) : null,
      reply_cer_mean: ok.length ? Number(mean(ok.map((x) => x.reply_cer).filter(Number.isFinite)).toFixed(4)) : null,
      comprehension_mean: ok.length ? Number(mean(ok.map((x) => x.comprehension).filter(Number.isFinite)).toFixed(3)) : null,
      ms_p95: ok.length ? [...ok.map((x) => x.ms)].sort((a, b) => a - b)[Math.min(ok.length - 1, Math.floor(0.95 * (ok.length - 1)))] : null,
      usd_per_turn_mean: ok.length ? Number(mean(ok.map((x) => x.usd).filter(Number.isFinite)).toFixed(5)) : null,
      limited: r.results.filter((x) => x.limited).length,
      tool_calls: r.tool_probe.tool_calls,
      endpoints: r.endpoints,
    };
  });
  summary.forEach((s) => {
    s.unmeasured = s.turns > 0 && s.ok === 0 && s.limited === s.turns;
    s.pass = s.unmeasured ? null : Boolean(s.ok === s.turns && s.audio_ok === s.ok && (s.reply_persian_mean ?? 0) >= 0.9 && (s.ms_mean ?? 1e9) <= 15000 && (s.comprehension_mean ?? 0) >= 0.6);
  });

  fs.mkdirSync(RESULTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(RESULTS, `s2s-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({ created: new Date().toISOString(), stt_for_roundtrip: sttModel || null, realtime: rt, summary, runs }, null, 2));
  console.log(`\n| model | ok | audio | reply fa | ms | $/turn | tools | pass |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const s of summary) console.log(`| ${s.model} | ${s.ok}/${s.turns} | ${s.audio_ok} | ${s.reply_persian_mean} | ${s.ms_mean} | ${s.usd_per_turn_mean} | ${(s.tool_calls || []).join("+") || "none"} | ${s.pass ? "PASS" : "fail"} |`);
  console.log(`\nwrote ${path.relative(ROOT, out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
