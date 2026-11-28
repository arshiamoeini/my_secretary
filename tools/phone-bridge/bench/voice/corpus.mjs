// Builds the Persian speech corpus the voice benchmark scores against.
//
// The bridge's whole job is to understand a real Iranian caller, so the test set
// is real recorded human Persian taken from public, licence-clean sources on the
// internet — not synthetic audio, and not English clips like the first round of
// system tests used.
//
// Sources (see SOURCES.md for the licence notes):
//   hezarai/common-voice-13-fa   Mozilla Common Voice fa, CC0, crowd-validated text
//   vhdm/persian-voice-v1        Persian voice clips with human-corrected text
//   C1Tech/Persian-ASR-Benchmark conversational/YouTube-style fa speech; the text
//                                is machine-labelled, so it is marked validated:false
//                                and excluded from the headline CER.
//
// Every clip is stored twice: `full.wav` (16 kHz mono, what the mic sees) and
// `phone.wav` (8 kHz, band-limited 300–3400 Hz, what a real telephone line sends).
// The phone variant is the one the call path actually faces.
//
// Usage: node bench/voice/corpus.mjs [--clips=16] [--refresh]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegOrNull, toWav, telephoneChain } from "./lib/audio.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = process.env.VOICE_CORPUS || path.join(ROOT, "vendor", "voice-corpus");
const SERVER = "https://datasets-server.huggingface.co";

const SOURCES = [
  { id: "cv13-fa", dataset: "hezarai/common-voice-13-fa", split: "train", ref: "sentence", license: "CC0 (Common Voice 13 mirror)", validated: true, domain: "read" },
  { id: "pvoice", dataset: "vhdm/persian-voice-v1", split: "train", ref: "corrected_sentence", license: "apache-2.0 card, CC0 audio (CV17)", validated: true, domain: "read" },
  { id: "c1bench", dataset: "C1Tech/Persian-ASR-Benchmark", split: "train", ref: "transcription", license: "not stated — robustness only", validated: false, domain: "conversational" },
];

const WORD_RANGE = [3, 14];

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
        continue;
      }
      return { __error: `${res.status} ${(await res.text()).slice(0, 160)}` };
    } catch (error) {
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      if (i === tries - 1) return { __error: String(error?.message || error) };
    }
  }
  return { __error: "unreachable" };
}

/** Pull candidate rows from a dataset through the HF rows API. */
async function candidates(source, limit) {
  const picked = [];
  const per = 100;
  for (let offset = 0; offset < 1200 && picked.length < limit; offset += per) {
    const url = `${SERVER}/rows?dataset=${encodeURIComponent(source.dataset)}&config=default&split=${source.split}&offset=${offset}&length=${per}`;
    const json = await getJson(url);
    const rows = json?.rows;
    if (!Array.isArray(rows) || !rows.length) break;
    for (const { row } of rows) {
      const ref = String(row?.[source.ref] ?? "").trim();
      const audio = Array.isArray(row?.audio) ? row.audio[0] : row?.audio;
      if (!ref || !audio?.src) continue;
      const words = ref.split(/\s+/).filter(Boolean).length;
      if (words < WORD_RANGE[0] || words > WORD_RANGE[1]) continue;
      if (/[a-zA-Z]/.test(ref)) continue; // read-speech sets are pure Persian; Latin means a bad row
      picked.push({ ref, src: audio.src, type: audio.type || "audio/mpeg", words });
      if (picked.length >= limit) break;
    }
    if (json?.features?.length && rows.length < per) break;
  }
  return picked;
}

/** deterministic spread so re-runs pick the same clips */
function spread(list, want) {
  if (list.length <= want) return list;
  const step = list.length / want;
  return Array.from({ length: want }, (_, i) => list[Math.floor(i * step)]);
}

async function main() {
  const wantTotal = Number(arg("clips", 16));
  const perSource = Math.max(2, Math.ceil(wantTotal / 2));
  const bin = ffmpegOrNull();
  if (!bin) {
    console.error("ffmpeg not found under tools/phone-bridge/vendor/ffmpeg — see bench/voice/README.md");
    process.exit(2);
  }
  fs.mkdirSync(path.join(OUT, "clips"), { recursive: true });

  const clips = [];
  const seen = new Set();
  for (const source of SOURCES) {
    const pool = await candidates(source, perSource * 6);
    const chosen = spread(pool, source.validated ? perSource : Math.max(2, Math.floor(perSource / 2)));
    console.log(`[${source.id}] pool=${pool.length} chosen=${chosen.length}`);
    for (const item of chosen) {
      if (seen.has(item.ref)) continue;
      seen.add(item.ref);
      const res = await fetch(item.src);
      if (!res.ok) {
        console.log(`  ! download ${res.status}`);
        continue;
      }
      const raw = Buffer.from(await res.arrayBuffer());
      if (raw.byteLength < 2000) continue;
      const ext = (item.type.includes("wav") ? "wav" : "mp3").replace(".", "");
      const id = `${source.id}-${sha(raw)}`;
      const dir = path.join(OUT, "clips", id);
      fs.mkdirSync(dir, { recursive: true });
      const src = path.join(dir, `source.${ext}`);
      fs.writeFileSync(src, raw);
      const full = path.join(dir, "full.wav");
      const phone = path.join(dir, "phone.wav");
      try {
        await toWav(bin, src, full, { rate: 16000, channels: 1 });
        await toWav(bin, src, phone, { rate: 8000, channels: 1, filters: telephoneChain() });
      } catch (error) {
        console.log(`  ! transcode ${id}: ${error.message}`);
        continue;
      }
      const dur = wavSeconds(full);
      if (!Number.isFinite(dur) || dur < 1.2 || dur > 15) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      clips.push({
        id,
        source: source.dataset,
        source_url: item.src.split("?")[0],
        licence: source.license,
        domain: source.domain,
        validated: source.validated,
        reference: item.ref,
        words: item.words,
        seconds: Number(dur.toFixed(3)),
        sha256: sha(raw),
        files: { source: path.relative(OUT, src), full: path.relative(OUT, full), phone: path.relative(OUT, phone) },
      });
      console.log(`  + ${id} ${dur.toFixed(1)}s "${item.ref.slice(0, 46)}"`);
    }
  }

  const manifest = {
    created: new Date().toISOString(),
    note: "Real recorded Persian speech from public datasets; phone.wav emulates the 8 kHz narrow-band path of a telephone call.",
    sources: SOURCES.map(({ dataset, split, ref, license }) => ({ dataset, split, ref_field: ref, license })),
    clips,
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  // The audio lives in vendor/ (gitignored), so the text half of the manifest is
  // copied next to the results: a reviewer can audit references and provenance
  // without downloading anything, and a re-run of corpus.mjs (same row order)
  // reproduces the same clips.
  fs.mkdirSync(path.join(ROOT, "bench", "voice", "results"), { recursive: true });
  fs.copyFileSync(path.join(OUT, "manifest.json"), path.join(ROOT, "bench", "voice", "results", "corpus-manifest.json"));
  console.log(`\ncorpus: ${clips.length} clips (${clips.filter((c) => c.validated).length} validated) → ${path.relative(ROOT, OUT)}/manifest.json`);
  if (clips.length < 8) {
    console.error("too few clips — not a valid benchmark set");
    process.exit(3);
  }
}

export function wavSeconds(file) {
  try {
    const b = fs.readFileSync(file);
    const byteRate = b.readUInt32LE(28);
    return (b.length - 44) / byteRate;
  } catch {
    return NaN;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
