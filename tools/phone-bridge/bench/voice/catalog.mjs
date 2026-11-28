// Snapshot of the Aval.ai audio catalogue: what exists, what it costs, what it
// claims to support. Written to results/models-audio.json so the benchmark tables
// can be read months later without trusting a live endpoint.
//
// Usage: node bench/voice/catalog.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvalVoice, resolveKey } from "./lib/api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RESULTS = path.join(HERE, "results");

const voice = new AvalVoice({ key: resolveKey(process.env, path.join(ROOT, "phone.config.json")), timeoutMs: 30000 });
const models = await voice.models();
if (!Array.isArray(models)) {
  console.error(String(models?.error || "model list failed"));
  process.exit(1);
}
const audio = models
  .filter((m) => String(m.mode || "").startsWith("audio") || m.supports_audio_input || m.supports_audio_output || (m.supported_endpoints || []).some((e) => e.includes("/audio/")))
  .map((m) => ({
    id: m.id,
    owned_by: m.owned_by,
    mode: m.mode,
    endpoints: m.supported_endpoints || [],
    min_tier: m.min_tier,
    rpm: m.max_requests_per_1_minute,
    audio_input: m.supports_audio_input ?? null,
    audio_output: m.supports_audio_output ?? null,
    realtime: (m.supported_endpoints || []).includes("/v1/realtime"),
    pricing: m.pricing || {},
    deprecated: m.deprecation_date || null,
  }))
  .sort((a, b) => (a.mode === b.mode ? a.id.localeCompare(b.id) : a.mode < b.mode ? -1 : 1));

fs.mkdirSync(RESULTS, { recursive: true });
const file = path.join(RESULTS, "models-audio.json");
fs.writeFileSync(file, JSON.stringify({ captured: new Date().toISOString(), source: "GET https://api.avalai.ir/v1/models", total: models.length, audio }, null, 2));
console.log(`catalogue: ${models.length} models, ${audio.length} with audio → ${path.relative(ROOT, file)}`);
const byMode = {};
for (const m of audio) byMode[m.mode] = (byMode[m.mode] || 0) + 1;
console.log(byMode);
for (const m of audio) {
  const p = m.pricing || {};
  const rate = p.input_cost_per_second ? `$${p.input_cost_per_second}/s in` : p.output_cost_per_second ? `$${p.output_cost_per_second}/s out` : p.input_cost_per_character ? `$${p.input_cost_per_character}/char` : p.audio_output ? `audio_out $${p.audio_output}/1M tok` : "—";
  console.log(`  ${m.mode.padEnd(19)} ${m.id.padEnd(34)} ${rate.padEnd(24)} tier=${m.min_tier}${m.realtime ? " realtime" : ""}${m.deprecated ? ` deprecated ${m.deprecated}` : ""}`);
}
