# bench/voice — choosing the Persian call voice from the Aval.ai catalogue

The parent benchmark (`bench/`) answers *which text model runs the call loop*.
This one answers the question that actually decides whether a Persian caller can
be served: **which audio models understand and produce Persian on a telephone
line**, measured with real recorded human speech instead of a synthetic or
English voice.

Run order (each step costs a little of the owner's Aval balance; totals are
written into `results/`):

```powershell
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
cd E:\home_works\my_secretary\tools\phone-bridge

node bench/voice/corpus.mjs --clips=16      # 1. download real fa speech, build the 8 kHz phone band
node bench/voice/probe.mjs                  # 2. smoke: does each endpoint answer at all
node bench/voice/stt-bench.mjs              # 3. every /audio/transcriptions model, both bands
node bench/voice/tts-bench.mjs              # 4. every /audio/speech model + round-trip fidelity
node bench/voice/s2s-bench.mjs              # 5. audio-in/audio-out chat models + /v1/realtime
node bench/voice/voice-loop.mjs --clips=4   # 6. the real bridge code, end to end (L3-lite)
node bench/voice/report.mjs                 # 7. VOICE-RESULTS.md from the saved JSON
```

## Files

| file | what it does |
| --- | --- |
| `corpus.mjs` | Builds `vendor/voice-corpus/` from public Persian speech (see `SOURCES.md`): `full.wav` 16 kHz + `phone.wav` 8 kHz band-limited 300–3400 Hz, with `manifest.json` (source URL, sha256, reference text). |
| `lib/api.mjs` | Aval client used by the benches: `/audio/speech`, `/audio/transcriptions`, `/chat/completions` with audio, `/models`. Redacts the key from every error. `retry()` absorbs tier rate-limits (Aval gives 3–100 audio requests/minute depending on tier) so 429 never becomes a fake "model is bad". |
| `lib/text.mjs` | Persian fold + CER/WER/containment/script checks. Locked by `test/voice-metrics.test.mjs`. |
| `lib/audio.mjs` | ffmpeg (vendored) transcode, telephone band, RMS. |
| `phrases.mjs` | The Persian sentences a school-office call says — greetings, digits, dates, names, the AI disclosure. |
| `stt-bench.mjs` | Discovers transcription models from the live catalogue, scores each on both bands. Writes `results/stt-parts/<model>__<band>.json` so a long sweep is resumable (`--force` to redo). |
| `tts-bench.mjs` | Scores speech models: validity (a stub payload is a failure), latency, RTF, price, and round-trip intelligibility through the best STT. The round-trip STT is deliberately a **different vendor family** than the voice under test, so no company grades its own homework. |
| `formats.mjs` | Which `response_format` each speech model really accepts. Finding on 2026-11-27: **ElevenLabs through Aval serves mp3 only** (wav/pcm → HTTP 503 from the upstream), while Gemini returns a proper WAV. The bridge therefore decodes mp3 with the vendored ffmpeg and refuses it loudly when that binary is missing (`tts-needs-transcoder`). |
| `catalog.mjs` | Saves `results/models-audio.json`: every audio model in the live catalogue with its published price, tier, RPM and endpoints, so the tables stay auditable without the API. |
| `s2s-bench.mjs` | `supports_audio_input && supports_audio_output` models: comprehension, Persian reply, reply audio, tool-calling with audio on, per-turn cost — plus a `/v1/realtime` WebSocket probe. |
| `voice-loop.mjs` | The production modules (`src/local/aval.mjs`, `src/config.mjs`, pinned `agent.model`) on real caller audio: hear → answer → speak → re-hear. Emits `results/loop-*.json`. |
| `report.mjs` | Regenerates `VOICE-RESULTS.md` from the newest saved run. No model calls. |

## Gates (why a model is rejected)

STT, per band: `CER ≤ 0.30` on validated clips · `non-empty ≥ 90%` · `p95 ≤ 8 s` ·
`≤ $0.05` for a 3-minute call · every HTTP call 2xx.

TTS: every phrase returns real audio (≥ 1000 bytes, RMS > 0.002, non-silent) ·
round-trip `CER ≤ 0.25` · `latin share ≤ 0.05` (an English voice reading Persian
fails here) · `p95 ≤ 6 s`.

S2S: audio reply on every turn · reply in Persian · whole turn ≤ 15 s.

Anything that fails a gate is reported with the gate name, not a bare "fail".

## What this cannot prove

* It never proves a human understood the voice — L5 is a person on the other end
  of a real handset (owner's job).
* The corpus is read speech in quiet rooms; a mobile caller in traffic is harder.
* No SIM, carrier or ADB leg is measured here: `voice-loop.mjs` is L3-lite on the
  PC audio route.
