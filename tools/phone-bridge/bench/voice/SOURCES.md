# Test corpus — where the Persian audio comes from

The benchmark must hear a real Iranian voice, so the clips are downloaded from
public datasets on the internet, not synthesised locally. `bench/voice/corpus.mjs`
builds the set; this file records what was actually used on 2026-11-25.

| id | dataset | what it is | licence | used for |
| --- | --- | --- | --- | --- |
| `cv13-fa` | [`hezarai/common-voice-13-fa`](https://huggingface.co/datasets/hezarai/common-voice-13-fa) | Mozilla Common Voice 13, Persian: crowd-recorded volunteers reading validated sentences (Common Voice releases are CC0) | CC0 (community mirror) | **headline CER/WER** |
| `pvoice` | [`vhdm/persian-voice-v1`](https://huggingface.co/datasets/vhdm/persian-voice-v1) | "Common Voice 17 Persian — ASR-Ready (Cleaned)": fa clips with human-corrected transcripts | apache-2.0 (cleaning), audio CC0 | **headline CER/WER** |
| `c1bench` | [`C1Tech/Persian-ASR-Benchmark`](https://huggingface.co/datasets/C1Tech/Persian-ASR-Benchmark) | 2 101 conversational/YouTube-style fa clips, `transcription` is machine-labelled | **not stated on the card** | domain-robustness only, marked `validated: false`, excluded from headline scores |

## Rules the builder follows

* Sentence must be 3–14 words, contain no Latin characters, and be unique.
* Duration after decode must be 1.2–15 s (a phone turn is short; anything longer
  stops being a caller sentence).
* Each clip is kept in two forms:
  * `full.wav` — 16 kHz mono, what a PC microphone captures;
  * `phone.wav` — 8 kHz mono, high-pass 300 Hz + low-pass 3400 Hz, i.e. the band a
    real telephone line carries. **This is the band the call decision is made on.**
* `manifest.json` records the source URL, a sha256 prefix, the reference text and
  the duration for every clip, so a re-run can be compared honestly.

## Honest limits

* Common Voice is **read speech** in a quiet room. A mobile caller in traffic, with
  a different accent or a weak SIM, will be worse than these numbers.
* Nothing here tests the acoustic path PC → phone earpiece → carrier → PC. That is
  L2/L3 on a real handset and needs the owner's phone.
* The `c1bench` references were produced by another ASR, so its CER column measures
  agreement with that system, not truth.

Fetched with the Hugging Face datasets-server rows/assets API on 2026-11-25; audio
files live in `vendor/voice-corpus/` (gitignored) and the manifest is the record.
