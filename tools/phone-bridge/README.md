# phone-bridge — real Iranian phone calls from a local SIM

The secretary agent dials an **ordinary Android phone** and holds a turn-by-turn
conversation. There is no telephony API, no SIP trunk, no account and no
per-minute platform fee (normal carrier charges apply): the carrier is the SIM in
the phone, ADB presses the buttons, and the PC supplies the voice.

```
                    ┌──────────────────────────── Windows PC ────────────────────────────┐
 Vanilla agent       │  tools/phone-bridge                                                │
 ──phone_call──────► │  dial()    ── adb shell am start -a CALL -d tel:+98… ──┐            │
 ──phone_say───────► │  say()     ── SAPI / PHONE_TTS_CMD ──► default speaker ─┼──► phone   │
 ──phone_listen────► │  listen()  ── default mic / ffmpeg ──► WAV ──► local STT │            │
 ──phone_hangup────► │  hangup()  ── adb shell telecom end-call ──────────────┘            │
                    └────────────────────────────────────────────────────────────────────┘
                                  ▲ ADB over USB (control)      ▲ Bluetooth HFP / TRRS / VB-CABLE (audio)
```

This mirrors [SIMVox-AI](https://github.com/Magraa/SIMVox-AI) (MIT): the phone
keeps its SIM and its dialer, and the PC only orchestrates. Compared with that
project this is dependency-free Node instead of Python: `child_process` for ADB,
Windows SAPI for TTS, `winmm` (MCI) or ffmpeg for capture, and any local
STT engine through a command template.

## 1. What works, and what cannot be verified without hardware

Verified on this machine:

- all 71 offline tests (number parsing, ADB output parsing, WAV conversion, every
  safety gate, the full conversation loop, the simulator, the Vanilla loop, the
  end-of-turn capture, the call-benchmark graders, the Aval voice engines and the
  Persian CER/WER scorer);
- `adb version` discovery and the "no device" diagnosis;
- Windows SAPI voice enumeration, real WAV synthesis, real playback;
- real MCI microphone capture and the 11 kHz → 16 kHz WAV conversion;
- the CLI readiness report, including its refusals;
- **the agent itself, on real calls**: `bench/` runs the actual Vanilla ReAct
  loop against this bridge (simulated conversations + live gate refusals) across
  aval.ai models and picks the cheapest one that passes with call-grade speed —
  see [`bench/README.md`](bench/README.md) and `bench/RESULTS.md`;
- **the voice path, on real Persian speech**: `bench/voice/` scores every Aval
  transcription and speech model against recorded human Persian (Common Voice fa),
  in both 16 kHz and the 8 kHz/300–3400 Hz telephone band, and drives the actual
  `hear → model → speak → re-hear` turn through the production modules —
  see [`bench/voice/README.md`](bench/voice/README.md) and
  `bench/voice/VOICE-RESULTS.md`.

Not verifiable here, because no phone or SIM is attached:

- a real call actually ringing and connecting on a carrier;
- the phone's call audio reaching the PC and the PC's voice reaching the caller;
- a human on the far end confirming the Persian was audible (L5).

The bridge never pretends otherwise: `readiness` and `selftest` fail loudly with
the exact missing step.

Handing development to another person or agent? Start with
[`NEXT-AGENT.md`](NEXT-AGENT.md): a copy-paste prompt, the ordered verification
ladder (offline tests → ADB → audio route → Persian TTS → STT → two-way call),
the traps already hit, and the current blocked levels.

## 2. Requirements

| Need | Notes |
| --- | --- |
| Android phone with a working SIM | Any version with a dialer; no root, no custom ROM |
| `adb` | Android platform-tools. `ADB_PATH` if not on `PATH` |
| Node.js 20+ | On this machine `node` is not on `PATH`; use `C:\Program Files\nodejs\node.exe` |
| A voice path (see §4) | Bluetooth HFP, a 3.5 mm TRRS splitter, or VB-CABLE |
| A Persian voice (see §5) | Otherwise Persian text fails by design |
| An STT engine (see §6) | Otherwise `phone_listen` returns empty text |

## 3. Try it with no hardware first

Node.js 20+ is required.

```powershell
cd tools\phone-bridge

# What is configured / missing (exit 1 when a live call is not yet possible)
node src\cli.mjs readiness

# A full turn-by-turn conversation with a scripted caller: no phone, no audio
$env:PHONE_SIMULATE  = "1"
$env:PHONE_SCRIPT    = "سلام، بفرمایید.`nفردا ساعت ده خوبه."
node src\cli.mjs call --to "۰۹۱۲ ۱۲۳ ۴۵۶۷" --greeting "سلام، دفتر مدرسه تماس می‌گیرم."
node src\cli.mjs listen
node src\cli.mjs say --text "بله، فردا ساعت ده منتظر شما هستیم."
node src\cli.mjs hangup
```

Simulation needs no phone, no microphone and no Persian voice; it exercises the
real session, turn log and transcript archive. It is also how the benchmark tests
the agent.

## 4. Connect the phone

### 4.1 Control (ADB)

1. On the phone: **Settings → About phone → tap Build number 7×** to enable
   Developer options.
2. **Developer options → USB debugging → on**. Connect the USB cable.
3. Accept the **Allow USB debugging** prompt on the phone.
4. Verify:

```powershell
adb devices -l
node src\cli.mjs devices     # state: CONNECTED, model, battery, carrier
```

Wireless debugging also works: pair once, then
`$env:ADB_WIRELESS = "192.168.1.50:5555"`.

The commands used are the same ones SIMVox-AI issues:

| Action | Command |
| --- | --- |
| Dial | `adb shell am start -a android.intent.action.CALL -d tel:+98912…` |
| Call state | `adb shell dumpsys telephony.registry` (`mCallState` 0/1/2) |
| Hang up | `adb shell telecom end-call`, fallback `input keyevent 6` |
| Answer | `adb shell telecom accept-call`, fallback `input keyevent 5` |

Pick one phone when several are attached: `$env:ADB_DEVICE_SERIAL = "ABC123"`.

### 4.2 Audio (the hard part)

ADB cannot carry voice. Windows must see the phone as an ordinary recording and
playback device. Choose one:

| Route | Wiring | Windows device |
| --- | --- | --- |
| **Bluetooth HFP** | Pair the phone with the PC; the phone must be in a call | `Headset Earphone (Bluetooth Hands-Free Audio)` / `Headset Microphone (…)` |
| **3.5 mm TRRS** | 4-pole cable + splitter into a USB sound card | `Microphone (USB Audio Device)` |
| **Virtual cable** | VB-CABLE or VoiceMeeter | `CABLE Output (VB-Audio Virtual Cable)` |

Then make that pair the **Windows default** devices, because the no-install
backends always use the default:

- SAPI playback → default **playback** device
- MCI capture → default **recording** device

```powershell
node src\cli.mjs audio     # lists endpoints, marks likely phone links
```

If ffmpeg is installed, name the devices explicitly instead of changing the
system default:

```powershell
$env:PHONE_AUDIO_BACKEND = "ffmpeg"
$env:PHONE_AUDIO_INPUT   = "CABLE Output (VB-Audio Virtual Cable)"
$env:PHONE_AUDIO_OUTPUT  = "CABLE Input (VB-Audio Virtual Cable)"   # informational
```

`PHONE_PLAY_CMD` replaces the playback side with any local player, e.g.
`PHONE_PLAY_CMD=ffplay -nodisp -autoexit -i "{wav}"`.

Verify the whole media path before dialing anyone:

```powershell
node src\cli.mjs selftest
```

It synthesizes a Persian sentence, plays it, records, and reports whether the PC
heard it. Acoustic echo through the speakers is **not** a valid test — the phone
link must be the actual route.

## 5. A Persian voice is mandatory

Windows ships English voices only (`Microsoft David`, `Microsoft Zira`). Ask one
of them to read Persian script and SAPI writes a **valid but empty 46-byte WAV**
and reports success. The bridge detects that and returns
`code: "tts-silent-output"` instead of playing silence into a live call, so
`readiness` reports `tts` as failed until this is fixed.

Three options, in the order the benchmark measured them (`bench/voice/`):

1. **Aval.ai voice — `PHONE_TTS_ENGINE=aval`** (what `phone.config.json` pins).
   The API exposes ElevenLabs, OpenAI TTS and Gemini TTS on
   `POST /v1/audio/speech`. The measured ranking over four real Persian call sentences
   (`bench/voice/`): **eleven_v4_turbo round-trip CER 0.050 at p95 1.5 s and $0.0007/s**,
   eleven_v3 0.0595, tts-1 0.0578, gemini-* 0.146–0.166 — while `eleven_flash_v2` (0.702)
   and `eleven_turbo_v2` (0.830) are exactly the "English voice reading Persian" failure
   this section exists to prevent. ElevenLabs documents Persian only for v3/v4, which the
   numbers agree with. If you would rather not depend on ffmpeg for the mp3 decode, pin
   `gemini-3.8-flash-lite-tts` + `Kore` + `tts_format=wav`, or `tts-1` + `alloy` + `wav`.

   ```powershell
   $env:PHONE_TTS_ENGINE = "aval"          # or "tts": {"engine": "aval"} in PHONE_CONFIG
   $env:PHONE_AVAL_TTS_MODEL = "eleven_v4_turbo"
   $env:PHONE_AVAL_TTS_VOICE = "onwK4e9ZLuTAKqWW03F9"   # measured Persian voice
   $env:PHONE_AVAL_TTS_FORMAT = "mp3"      # ElevenLabs through Aval serves mp3 only
   $env:AVAL_API_KEY = "aa-..."            # optional: the Avalai provider config is reused
   ```

   `speak()` returns `usd` per turn (the price table is cached under the audit dir), and
   `PHONE_AVAL_BUDGET_USD` (default $0.15 ≈ two minutes on the pinned pair) caps what one
   call may spend: past the cap, `phone_say` and `phone_listen` return
   `voice-budget-exceeded` instead of continuing to bill.

2. **Windows voice** — Settings → Time & language → Language & region → add
   *Persian* → Language options → **Speech** (download). Then:

   ```powershell
   node src\cli.mjs voices                  # confirms a fa-IR voice
   $env:PHONE_TTS_VOICE = "Microsoft Dilara"  # optional
   ```

3. **Local engine** (`PHONE_TTS_ENGINE=cmd`) — Piper with `fa_IR-amir-medium` or
   eSpeak-NG. On this machine the vendored Piper binary is unusable for Persian
   (it rejects the multi-codepoint phoneme `aɪ`), so this route is unproven here;
   it is kept because it costs nothing per call.

```powershell
$env:PHONE_TTS_ENGINE = "cmd"
$env:PHONE_TTS_CMD = 'C:\tools\piper\piper.exe --model C:\tools\piper\fa_IR-amir-medium.onnx --output_file "{out}" --input_file "{text_file}"'
# or eSpeak-NG
# $env:PHONE_TTS_CMD = 'C:\tools\espeak\espeak-ng.exe -v fa -w "{out}" -f "{text_file}"'
```

Command templates are **argv**, not shell lines: they are split on whitespace
with quote awareness and spawned directly, so no `cmd.exe` quoting issues and no
shell injection from transcript text. Supported placeholders: `{out}`,
`{text_file}`, `{text}` for TTS; `{wav}`, `{language}`, `{out}` for STT; `{wav}`
for playback. The same text is also exported as `PHONE_TTS_TEXT`,
`PHONE_TTS_TEXT_FILE`, `PHONE_TTS_OUT` if a script prefers environment variables.

Templates must finish synchronously and write the file before exiting.

## 6. Speech-to-text

Two engines are supported:

```powershell
# Aval.ai API (measured on real recorded Persian speech, 8 kHz telephone band)
$env:PHONE_STT_ENGINE = "aval"
$env:PHONE_AVAL_STT_MODEL = "scribe_v2"                  # CER 0.0081 · p95 4.0 s · $0.000062/s
$env:PHONE_AVAL_STT_LANGUAGE = "fa"
$env:PHONE_AVAL_STT_PROMPT = "دفتر مدرسه، ولی دانش‌آموز، غیبت، اجازه خروج، شماره تماس"
# budget alternative, also passing: groq.whisper-large-v3-turbo (CER 0.0393, $0.002 per 3 min)
# NOT suitable: gpt-4o-mini-transcribe (CER 0.3359 on the phone band, Latin hallucinations)

# or a local whisper.cpp build (nothing is bundled; models are 50–500 MB)
$env:PHONE_STT_CMD = 'C:\tools\whisper\whisper-cli.exe -m C:\tools\whisper\ggml-base.bin -l fa -nt -f "{wav}"'
```

The API engine sends the recorded WAV to `POST /v1/audio/transcriptions` and
returns the transcript, the model, the latency and the price of that turn. A
401/404/429 or a timeout comes back as an explicit error with the server's own
message (the key is redacted before anything is logged) — never as silence.

Recording is done at 16 kHz mono 16-bit PCM (`PHONE_SAMPLE_RATE`), converted in
pure JavaScript from whatever the device produced — MCI often records 11 kHz
8-bit, which needs the conversion before recognition.

If no engine is configured, `phone_listen` still records, reports
`stt: {ok: false, code: "stt-not-configured"}`, and returns `text: ""`. An empty
transcript is **never** replaced by a guess.

## 7. Going live

The allowlist should contain **real** destinations. `REAL-NUMBERS.md` lists the
verified public auto-answering numbers usable for hardware bring-up (first
target: Irancell support `09377000000`, 11-digit form) and explains why carrier
short codes (`9990`, `700`, `200`, `118`) are rejected by the number validator.
The human's own number goes in the file, never in git.

```powershell
$env:PHONE_ALLOWLIST   = "09377000000"   # plus your own test line — see REAL-NUMBERS.md
$env:PHONE_ALLOW_DIAL  = "1"             # explicit approval for real dialing
$env:PHONE_MAX_CALLS   = "2"             # real dials per rolling hour

node src\cli.mjs readiness               # ready to dial: yes / ready to talk: yes
node src\cli.mjs call --to 09377000000 --greeting "سلام، این یک تماس آزمایشی است."
node src\cli.mjs listen --seconds 8 --until-silence
node src\cli.mjs say --text "خیلی خوب، ممنون."
node src\cli.mjs hangup
```

Prefer a file? Copy `phone.config.example.json` to `phone.config.json`
(gitignored), fill it in, and set `PHONE_CONFIG` to its path. Environment
variables win over the file. `phone.config.json` is also where the pinned call
brain lives (§8), so the model choice survives closed PowerShell windows.

### Safety gates (checked in this order)

1. **Number validation** — Iranian mobile (`09xxxxxxxxx`) or landline (`0xx…`);
   accepts `+98`, `0098`, `98`, bare national, Persian/Arabic digits, spaces and
   dashes.
2. **One call at a time** — a second dial while a session is open is refused
   (`call-in-progress`).
3. **Human approval** — `PHONE_ALLOW_DIAL=1` or `--allow-dial`. Without it a real
   dial is blocked *before* ADB runs. This is deliberate: an agent must never
   decide on its own to call a real person.
4. **Allowlist** — if `PHONE_ALLOWLIST` is set, every other destination is
   blocked (`not-allowlisted`).
5. **Rolling call cap** — `PHONE_MAX_CALLS` (default 3) real dials per hour,
   counted from the audit log (`call-cap`). Dry runs and simulated calls never
   consume this budget.
6. **Audio guards** — an empty or silent recording is reported as silent, and an
   empty TTS WAV is refused rather than played.
7. **Text cap** — 1200 characters per utterance (`PHONE_MAX_TEXT`).
8. **Audit** — every dial, say, listen and hangup (including dry runs and
   blocks) is appended to `.tmp/phone-bridge/calls.jsonl`; each finished call's
   transcript is archived under `.tmp/phone-bridge/calls/`.
9. **AI disclosure** — `PHONE_ANNOUNCE_AI` (default on) records that the
   assistant identifies itself as automated. Check the rules that apply to your
   calls; do not silently remove it.

`PHONE_DRY_RUN=1` forces preview mode even when dialing is approved.

## 8. Connecting it to Vanilla

The phone tools are opt-in so the existing benchmark result stays reproducible:

```powershell
$env:PHONE_TOOL = "1"        # adds the five phone tools and their prompt section
node benchmark\run.mjs --tool=vanilla ...
```

The agent gets `phone_call`, `phone_say`, `phone_listen`, `phone_status`,
`phone_hangup` and holds the conversation itself — the bridge is a mouth and an
ear, not a dialogue policy:

```json
{"ok":true,"code":"in-call","state":"IN_CALL","id":"call-20261120T101500-1",
 "to":{"national":"09121234567","e164":"+989121234567","kind":"mobile"},
 "answered":true,"device":{"serial":"ABC123","model":"Pixel 7"},
 "greeting":{"ok":true,"chars":38,"engine":"sapi","voice":"Microsoft Dilara","culture":"fa-IR"}}
```

Failures come back as data, never exceptions:

```json
{"ok":false,"blocked":true,"code":"dial-not-approved",
 "error":"real dialing is not approved: set PHONE_ALLOW_DIAL=1 ..."}
```

`phone_listen` returns `{"text":"…","empty":false,"hasSpeech":true,"stt":{"ok":true}}`
or an explicit empty result with a reason. `phone_status` reconciles the session
with the phone's live telephony state — a call ended on the phone is archived and
reported as `IDLE`.

With `PHONE_TOOL` unset the adapter sends exactly the original five tools and
system prompt.

### 8.1 Choosing the brain (cost-optimised, benchmarked)

The voice path is 100% local and free; the only per-call spend is the ReAct
model. `tools/phone-bridge/bench/` runs the real loop against the real bridge
(simulated conversations plus live gate refusals) across the cheap aval.ai
models and scores four things: task completion, honesty under silence, the two
safety gates (allowlist, approval), and **per-step latency** — the number that
decides whether a caller waits an unnatural amount between sentences.

Run the sweep and it writes the ranked table plus the winner:

```powershell
cd tools\phone-bridge
node bench/run.mjs --label=sweep        # see bench/RESULTS.md
```

The winner (cheapest model passing all four scenarios within the speed budget)
is pinned for phone work by putting it in `phone.config.json` under
`agent.model` (or `PHONE_AGENT_MODEL`). The Vanilla adapter reads it only when
`PHONE_TOOL=1`, so the main benchmark's model parity is untouched. See
`bench/README.md`.

## 9. CLI

```
node src\cli.mjs readiness [--json]      check adb, phone, voices, audio, STT
node src\cli.mjs devices   [--json]      ADB devices + battery/carrier
node src\cli.mjs audio     [--json]      Windows audio endpoints and backend
node src\cli.mjs voices    [--json]      installed local TTS voices
node src\cli.mjs normalize <number>      canonical Iranian number
node src\cli.mjs selftest [--seconds 4]  speak a phrase, then record it back

node src\cli.mjs call --to <number> [--greeting "words"] [--dry-run] [--simulate] [--allow-dial]
node src\cli.mjs say --text "words"
node src\cli.mjs listen [--seconds 8] [--until-silence]
node src\cli.mjs status
node src\cli.mjs hangup
node src\cli.mjs log [--limit 20]
```

Exit codes: `0` ok, `1` error, `2` blocked by a safety gate.

## 10. Persistence notes

The session lives in `.tmp/phone-bridge/session.json` so the CLI and the agent
(separate processes) see the same call. One call at a time is enforced there on
purpose; a stale second session is how accidental double-dials happen. Deleting
the file is safe when no call is active.

## 11. Tests

```powershell
cd tools\phone-bridge
node --test test/
```

77 tests, all offline — no network, no phone, no audio hardware. They cover every
accepted number spelling, ADB device/call-state parsing, the documented ADB
commands, WAV round-trip and resampling, empty-WAV detection, transcript
cleaning, TTS voice selection and command-tokenization, each safety gate (dry
run, approval, allowlist, hourly cap with dry runs excluded, single session), a full
greet→listen→reply→hangup→archive call, the scripted simulator, readiness
honesty, a real local STT command, the four Vanilla-loop tests against a local
fake model server (parity when disabled, a simulated conversation, a long
transcript that must stay valid JSON, and the approval gate), the
**end-of-turn capture** (`PHONE_LISTEN_UNTIL_SILENCE`: trailing-silence
measurement, chunk joining, stop-after-speech, unchanged fixed-window default,
dead-air capped at 4 s), four **call-benchmark grader self-tests** that
prove the `bench/` validators accept clean behaviour and reject fabricated
transcripts, unreported blocks and workarounds, the **Aval voice engines** against
a local fake `api.avalai.ir` (wav/pcm/mp3 handling, silent-stub rejection, 401/404/
timeout mapping, key redaction, price accounting, the per-call budget gate), the
**Persian CER/WER scorer** (ZWNJ, Arabic letters, diacritics, spoken vs written
numbers, empty and hallucinated output), and **capture-backend selection** (MCI
stays default; ffmpeg only when a device is named).

ADB, TTS, audio and STT are injected in tests; no test can place a call and no test
calls the network.

## 12. Files

```
tools/phone-bridge/
  src/index.mjs            dial / say / listen / hangup / status / readiness / selftest
  src/config.mjs           env + PHONE_CONFIG loader, dial gates, agent.model
  src/numbers.mjs          Iranian number canonicalization
  src/session.mjs          one-call session, turn log, transcript
  src/store.mjs            JSONL audit + transcript archive
  src/local/adb.mjs        ADB control plane (device, dial, state, hangup, telemetry)
  src/local/audio.mjs      capture/playback (MCI / ffmpeg) + endpoint listing
  src/local/wav.mjs        WAV decode/encode/resample, silence + end-of-turn analysis
  src/local/tts.mjs        SAPI + PHONE_TTS_CMD + Aval dispatch, Persian-voice guard
  src/local/stt.mjs        PHONE_STT_CMD runner + Aval dispatch
  src/local/aval.mjs       Aval.ai voice engines: speak() / hear(), pricing, key redaction
  src/local/shell.mjs      argv-style command templates
  src/local/win.mjs        PowerShell + .NET helpers
  test/                    unit + Vanilla integration + VAD + voice-engine + bench-grader tests
  bench/                   the call benchmark: scenarios, sweep runner, pricing, results
  bench/voice/             the Persian voice benchmark: corpus, stt/tts/s2s benches, verdict
  NEXT-AGENT.md            handoff prompt + verification ladder for the next developer
  VERIFICATION.md          dated evidence for each level (PASS/BLOCKED/FAIL)
  REAL-NUMBERS.md          verified real Iranian numbers for the allowlist (+ gaps)
  phone.config.example.json
```

Adapter change: `benchmark/adapters/vanilla.mjs` gains `phoneTools`, a conditional
system-prompt section and a dispatch branch — all behind `PHONE_TOOL=1`; plus a
model override (`BENCH_MODEL` / `PHONE_MODEL` / `agent.model`) used only by phone
work, leaving `PHONE_TOOL`-unset parity intact.

## 13. What still needs a human

- A phone with a SIM and credit, USB debugging enabled, and the RSA prompt
  accepted (`adb devices` must list it as `device`).
- One audio route (§4.2) set as the Windows default, or ffmpeg with explicit
  device names.
- A Persian voice (§5) or a local Persian TTS engine.
- An STT engine (§6) for two-way conversation.
- Explicit `PHONE_ALLOW_DIAL=1` approval for production use, plus a decision on
  quiet hours and which numbers the secretary may dial.

## 14. Limits worth knowing before promising anything

- **One call at a time.** One SIM, one line.
- **Latency.** With the default fixed window plus local STT, turns take a few
  seconds; this is a phone call, not a low-latency voice agent.
  `PHONE_LISTEN_UNTIL_SILENCE=1` cuts the dead time: `listen` records in 2 s
  chunks and returns as soon as the caller has been quiet for
  `PHONE_SILENCE_MS` (1200 ms default), and pure silence ends after 4 s instead
  of the full window. Chunk gaps (MCI spawns a recorder per chunk) are the
  trade-off — worth testing on your own route before an important call.
- **Bluetooth HFP quality.** Hands-free audio is 8–16 kHz and mono; it sounds
  like a car kit, because that is what it is.
- **The phone must stay connected and awake** with the app foregrounded enough
  for the dialer; some ROMs block `am start`-driven calls when the screen is off.
  Test with your phone's power settings before an important call.
- **No call recording of the far end beyond STT.** Audio is deleted after
  transcription unless `PHONE_KEEP_AUDIO=1`.
- **Machine-dependent.** SAPI, MCI and PowerShell are Windows-only; on other
  platforms set `PHONE_TTS_CMD`, `PHONE_STT_CMD`, `PHONE_PLAY_CMD` and
  `PHONE_AUDIO_BACKEND=ffmpeg`.

Compliance note: unsolicited marketing calls are regulated in Iran. Keep the
allowlist, identify the school at the start of the call, and only call numbers
tied to a real office interaction.
