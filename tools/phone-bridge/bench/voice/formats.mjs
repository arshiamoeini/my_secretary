// What formats does each speech model actually accept, and what do the failures
// say? The bridge refuses mp3 at call time (no transcoder on the call path), so
// this decides which engines are even usable.
//
// Usage: node bench/voice/formats.mjs [model1,model2]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvalVoice, resolveKey } from "./lib/api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const voice = new AvalVoice({ key: resolveKey(process.env, path.join(ROOT, "phone.config.json")), timeoutMs: 60000 });
const models = (process.argv[2] || "eleven_v4,eleven_multilingual_v2,eleven_flash_v2_5,tts-1,gemini-3.8-flash-lite-tts").split(",");
const formats = ["wav", "pcm", "mp3"];
const TEXT = "سلام، وقت بخیر.";

for (const model of models) {
  const row = [];
  for (const format of formats) {
    const r = await voice.speech({ model, input: TEXT, voice: "onwK4e9ZLuTAKqWW03F9", format });
    if (r.ok) {
      const head = r.bytes?.length > 12 ? Buffer.from(r.bytes.subarray(0, 12)).toString("ascii") : "";
      row.push(`${format}=OK ${r.bytes?.byteLength || r.bytes?.length}B ${head.startsWith("RIFF") ? "wav-header" : head.startsWith("ID3") || head.startsWith(" Ogg") ? "mp3-header" : "raw"} ${r.ms}ms`);
    } else {
      const msg = String(r.error || "").replace(/\s+/g, " ").slice(0, 130);
      row.push(`${format}=HTTP${r.status} ${msg}`);
    }
  }
  console.log(`${model}\n  ${row.join("\n  ")}\n`);
}
