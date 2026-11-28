// One-shot capability probe: what does Aval actually answer for Persian audio?
// Run: node bench/voice/probe.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvalVoice, resolveKey } from "./lib/api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const key = resolveKey(process.env, path.join(ROOT, "phone.config.json"));
const voice = new AvalVoice({ key, timeoutMs: 90000 });
const FA = "سلام، وقت بخیر. من دستیار تلفنی دفتر مدرسه هستم.";
const out = [];

for (const [model, fmt, v] of [
  ["eleven_multilingual_v2", "mp3", "onwK4e9ZLuTAKqWW03F9"],
  ["eleven_flash_v2_5", "mp3", "onwK4e9ZLuTAKqWW03F9"],
  ["eleven_v3", "mp3", "onwK4e9ZLuTAKqWW03F9"],
  ["gemini-2.5-flash-preview-tts", "mp3", "Kore"],
  ["gemini-3.8-flash-tts", "mp3", "Kore"],
  ["groq.playai-tts", "mp3", "atlas"],
  ["tts-1", "wav", "alloy"],
]) {
  const r = await voice.speech({ model, input: FA, voice: v, format: fmt });
  out.push({ kind: "tts", model, ok: r.ok, status: r.status, bytes: r.bytes?.length || 0, ms: r.ms, err: r.error ? String(r.error).slice(0, 160) : null });
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor", "voice-corpus", "manifest.json"), "utf8"));
const clip = manifest.clips.find((c) => c.validated && c.words >= 6) || manifest.clips[0];
for (const band of ["full", "phone"]) {
  const buf = fs.readFileSync(path.join(ROOT, "vendor", "voice-corpus", clip.files[band]));
  for (const model of ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "scribe_v2", "groq.whisper-large-v3"]) {
    const r = await voice.transcribe({ model, file: buf, filename: `${band}.wav`, language: "fa" });
    out.push({ kind: "stt", model, band, ok: r.ok, ms: r.ms, ref: clip.reference, text: r.ok ? r.text.slice(0, 160) : null, err: r.error ? String(r.error).slice(0, 160) : null });
  }
}
console.log(JSON.stringify(out, null, 1));
