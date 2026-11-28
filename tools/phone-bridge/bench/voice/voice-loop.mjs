// End-to-end Persian voice turn through the real bridge code — no phone needed.
//
// This is L3-lite: the audio route is the PC, not the SIM, so it proves the
// speech chain, not the call. For every clip of real recorded Persian speech:
//
//   caller.wav (8 kHz telephone band)
//     → src/local/aval.mjs hear()        what the agent heard
//     → the pinned call model            what the agent answers
//     → src/local/aval.mjs speak()       the WAV the caller would hear
//     → hear() again                     proof the answer is intelligible Persian
//
// Everything is measured with the production modules and the production config,
// so the latency and the price are the numbers a real call will show (minus the
// carrier leg and the ADB leg).
//
// Usage: node bench/voice/voice-loop.mjs [--clips=4] [--no-llm] [--loopback] [--band=phone]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.mjs";
import { hear, speak } from "../../src/local/aval.mjs";
import { probeWav } from "../../src/local/wav.mjs";
import { cer, fold, normalize } from "./lib/text.mjs";
import { ffmpegOrNull, telephoneChain, toWav } from "./lib/audio.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CORPUS = path.join(ROOT, "vendor", "voice-corpus");
const RESULTS = path.join(HERE, "results");
const OUT = path.join(ROOT, "vendor", "voice-loop");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

const SYSTEM = [
  "تو منشی تلفنی دفتر مدرسه هستی و با یک ولی ایرانی صحبت می‌کنی.",
  "فقط فارسی، کوتاه (حداکثر دو جمله)، محترمانه و بدون تکیه‌کلام‌های انگلیسی جواب بده.",
  "اگر caller چیزی گفت که باید ثبت شود، آن را در پاسخ تکرار کن تا تأیید شود.",
  "اگر متن شنیده‌شده خالی بود بگو نشنیدی؛ اگر پر بود هرگز نگو «نشنیدم» — همان را تأیید کن یا درباره‌اش سؤال بپرس.",
].join(" ");

/** One agent turn against the model pinned in phone.config.json (agent.model). */
async function agentReply(config, heard, fetchImpl = globalThis.fetch) {
  const model = config.agent.model;
  const key = config.aval.apiKey;
  if (!model || !key) return { ok: false, error: "agent.model or Aval key missing", text: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const started = Date.now();
  try {
    const res = await fetchImpl(`${config.aval.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 220,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `متن شنیده‌شده از تماس‌گیرنده: «${heard || "(چیزی شنیده نشد)"}»` },
        ],
      }),
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`, text: "", ms: Date.now() - started };
    const usage = json.usage || {};
    const price = (usage.prompt_tokens || 0) * 0.0000025 + (usage.completion_tokens || 0) * 0.00001;
    return {
      ok: true,
      text: String(json.choices?.[0]?.message?.content || "").trim(),
      ms: Date.now() - started,
      model,
      usd: Number(price.toFixed(6)),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), text: "", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const config = loadConfig({ ...process.env, PHONE_CONFIG: process.env.PHONE_CONFIG || path.join(ROOT, "phone.config.json") });
  if (config.tts.engine !== "aval" || config.stt.engine !== "aval") {
    console.error("phone.config.json must set tts.engine=aval and stt.engine=aval for this test");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, "manifest.json"), "utf8"));
  const band = String(arg("band", "phone"));
  const limit = Number(arg("clips", 4));
  const useLlm = arg("no-llm", "0") !== "1";
  const loopback = process.argv.includes("--loopback") || arg("loopback", "0") === "1";
  const bin = ffmpegOrNull();
  fs.mkdirSync(OUT, { recursive: true });

  const clips = manifest.clips.filter((c) => c.validated).slice(0, limit);
  console.log(`voice loop: ${clips.length} real Persian clips, band=${band}, llm=${useLlm}, loopback=${loopback}`);
  console.log(`stt=${config.aval.sttModel} tts=${config.aval.ttsModel} (${config.aval.ttsVoice || "default voice"}) agent=${config.agent.model || "none"}\n`);

  const turns = [];
  for (const clip of clips) {
    const incoming = path.join(CORPUS, clip.files[band]);
    const heard = await hear(config, incoming);
    const turn = {
      clip: clip.id,
      reference: clip.reference,
      heard: heard.text,
      heard_ok: heard.ok,
      heard_error: heard.error || null,
      stt_ms: heard.ms,
      stt_usd: heard.usd,
      heard_cer: heard.ok ? Number(cer(clip.reference, heard.text).toFixed(4)) : null,
    };

    let replyText;
    let llm;
    if (useLlm) {
      llm = await agentReply(config, heard.text);
      replyText = llm.text || "";
    } else {
      llm = { ok: true, ms: 0, usd: 0, model: "echo" };
      replyText = `متوجه شدم: «${normalize(heard.text)}». ممنون، ثبت شد.`;
    }
    turn.reply = replyText;
    turn.llm_ms = llm.ms;
    turn.llm_usd = llm.usd;
    turn.llm_ok = llm.ok;

    const said = await speak(config, replyText, { out: path.join(OUT, `${clip.id}-reply.wav`) });
    turn.say_ok = said.ok;
    turn.say_error = said.error || null;
    turn.say_ms = said.ms;
    turn.say_usd = said.usd;
    if (said.ok) {
      const studied = probeWav(said.path);
      turn.reply_seconds = Number(studied.duration.toFixed(2));
      turn.reply_sample_rate = studied.sampleRate;
      turn.reply_path = path.relative(ROOT, said.path);

      // what the caller hears: re-band to the telephone path when asked
      let listenTo = said.path;
      if (loopback && bin) {
        listenTo = path.join(OUT, `${clip.id}-loopback.wav`);
        await toWav(bin, said.path, listenTo, { rate: 8000, channels: 1, filters: telephoneChain() });
        turn.loopback_banded = true;
      }
      const back = await hear(config, listenTo);
      turn.reheard = back.ok ? back.text : null;
      turn.reheard_cer = back.ok ? Number(cer(replyText, back.text).toFixed(4)) : null;
      turn.reheard_ms = back.ms;
      turn.reheard_usd = back.usd;
      turn.turn_ms = (heard.ms || 0) + (llm.ms || 0) + (said.ms || 0) + (back.ms || 0);
      turn.turn_usd = Number(((heard.usd || 0) + (llm.usd || 0) + (said.usd || 0) + (back.ms ? back.usd || 0 : 0)).toFixed(6));
    }

    turns.push(turn);
    console.log(`— ${clip.id}`);
    console.log(`  caller   : ${clip.reference}`);
    console.log(`  heard    : ${turn.heard || "(nothing)"}   cer=${turn.heard_cer}  ${turn.stt_ms}ms`);
    console.log(`  agent    : ${turn.reply}`);
    console.log(`  spoken   : ${turn.say_ok ? `${turn.reply_seconds}s @${turn.reply_sample_rate}Hz, ${turn.say_ms}ms, $${turn.say_usd}` : `FAILED ${turn.say_error}`}`);
    if (turn.reheard !== undefined) console.log(`  caller hears: ${turn.reheard || "(nothing)"}   cer=${turn.reheard_cer}`);
    console.log(`  turn total: ${turn.turn_ms}ms  $${turn.turn_usd}\n`);
  }

  const okTurns = turns.filter((t) => t.heard_ok && t.say_ok);
  const summary = {
    clips: turns.length,
    successful_turns: okTurns.length,
    mean_heard_cer: okTurns.length ? Number((okTurns.reduce((a, t) => a + (t.heard_cer ?? 1), 0) / okTurns.length).toFixed(4)) : null,
    mean_reheard_cer: okTurns.filter((t) => Number.isFinite(t.reheard_cer)).length
      ? Number((okTurns.reduce((a, t) => a + (t.reheard_cer ?? 1), 0) / okTurns.filter((t) => Number.isFinite(t.reheard_cer)).length).toFixed(4))
      : null,
    mean_turn_ms: okTurns.filter((t) => t.turn_ms).length ? Math.round(okTurns.reduce((a, t) => a + (t.turn_ms || 0), 0) / okTurns.filter((t) => t.turn_ms).length) : null,
    total_usd: Number(turns.reduce((a, t) => a + (t.turn_usd || 0), 0).toFixed(6)),
    engines: { stt: config.aval.sttModel, tts: config.aval.ttsModel, tts_voice: config.aval.ttsVoice, agent: config.agent.model, band, loopback },
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `loop-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ created: new Date().toISOString(), summary, turns }, null, 2));
  console.log(`summary: turns=${summary.successful_turns}/${summary.clips} heard_cer=${summary.mean_heard_cer} replied_intelligible=${summary.mean_reheard_cer} mean_turn=${summary.mean_turn_ms}ms total=$${summary.total_usd}`);
  console.log(`wrote ${path.relative(ROOT, file)}`);
  if (!okTurns.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
