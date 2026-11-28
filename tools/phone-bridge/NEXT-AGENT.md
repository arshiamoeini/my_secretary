# Handoff — phone-bridge: prove a real Iranian call, then finish it

> **Newer status first — read `HANDOFF-2026-11-27.md`.** Since `HANDOFF-2026-11-25.md`
> the **Persian voice path was built, measured on real recorded human speech (16 kHz and
> the 8 kHz telephone band) and pinned**: `src/local/aval.mjs` (engines
> `PHONE_TTS_ENGINE=aval` / `PHONE_STT_ENGINE=aval`), `bench/voice/` (corpus, STT/TTS
> benches, `VOICE-RESULTS.md`), 79/79 offline tests, per-turn pricing behind a
> `voice-budget-exceeded` cap. **Two hard facts for the next session: the voice benchmark
> cost ≈ $0.81 against a $0.05 ceiling (sweeps were stopped mid-run), and the Aval balance
> is now 0.033 units — `insufficient_quota`, so nothing paid runs until the owner tops it
> up.** `hear()` has still never completed a live call, and L1/L2/L4/L5 still need the
> phone. Everything below stays valid.

**For the project owner (فارسی):** این فایل همان «پرومپت + دستور عمل» است. ساده‌ترین
راه این است که فقط بخش A را به‌عنوان اولین پیام به agent بعدی بدهید تا خودش این
فایل را بخواند؛ یا کل متن از بخش ۰ به بعد را بدهید. هدفش این است که agent اول
واقعیت را روی سخت‌افزار اثبات کند، بعد توسعه بدهد — نه اینکه دوباره ادعای
«کار می‌کند» بدون شاهد بنویسد.

Two ways to use it:

- **Short (recommended):** paste §A as the first message. The agent reads this
  file from disk, so it gets the full manual without a giant prompt.
- **Full:** paste everything from §0 to the end as the first message.

---

## A. Starter message (copy this)

> You are taking over `tools/phone-bridge` in `E:\home_works\my_secretary`: a
> local bridge that places real Iranian phone calls through the SIM in an Android
> phone (ADB control + local TTS/STT; no telephony API, no per-minute platform
> fee — normal carrier charges apply).
>
> Before doing anything, read `tools/phone-bridge/NEXT-AGENT.md` completely, then
> `README.md`, `src/index.mjs`, and the tests. Node is not on `PATH`; use
> `C:\Program Files\nodejs\node.exe` or prepend
> `C:\Users\Arshia\AppData\Local\Android\Sdk\platform-tools;C:\Program Files\nodejs;`
> to `PATH`.
>
> Your first deliverable is evidence, not features: climb the verification ladder
> in §5 (offline tests → ADB → audio route → Persian TTS → capture → two-way call)
> and record every result in `tools/phone-bridge/VERIFICATION.md`. If the hardware
> is missing, say so and mark the level `BLOCKED`; never fake a pass.
>
> Hard rules: no third-party telephony API (Aval.ai may carry **voice**, never the
> call — see §3 rule 2); never weaken
> `PHONE_ALLOW_DIAL`, `PHONE_ALLOWLIST`, `PHONE_MAX_CALLS` or the one-session
> guard; keep `PHONE_TOOL` unset parity in `benchmark/adapters/vanilla.mjs`; do not
> commit or spend money without asking; keep the 44 offline tests green and the
> counts in `README.md` accurate.
>
> Start by running `node --test test/` and `node src\cli.mjs readiness --json`,
> then report the current blocked levels and your plan before editing code.

---

## 0. Your first ten minutes

You are taking over `tools/phone-bridge` in `E:\home_works\my_secretary`. Read these,
in this order, before editing anything:

1. `tools/phone-bridge/README.md` — the public contract: setup, hardware routes,
   gates, limits. Its §1 ("What works, and what cannot be verified") is the
   honesty baseline you must preserve.
2. `tools/phone-bridge/src/index.mjs` — `dial / say / listen / hangup / status /
   readiness / selftest`, the gates and the session lifecycle.
3. `tools/phone-bridge/bench/` — the call benchmark (scenarios S1–S4, sweep
   runner, `pricing.json`, `RESULTS.md`). It pins the phone brain via
   `phone.config.json → agent.model`.
4. `tools/phone-bridge/src/local/*.mjs` — ADB, audio (MCI/ffmpeg), WAV, SAPI,
   STT, argv templates.
5. `tools/phone-bridge/test/*.test.mjs` — what is actually asserted, including
   Vanilla parity, end-of-turn capture, and the bench-grader self-tests.
6. `benchmark/adapters/vanilla.mjs` lines ~20–300 — the opt-in `PHONE_TOOL=1`
   integration and the model resolution (`BENCH_MODEL` > `PHONE_MODEL` >
   `agent.model` from `PHONE_CONFIG` > matrix model). Do not touch `benchmark/`
   beyond this file unless the task is explicitly a benchmark task;
   `benchmark/NEXT-AGENT.md` governs that tree.

Then establish the baseline (Node is **not** on `PATH` on this machine):

```powershell
cd E:\home_works\my_secretary\tools\phone-bridge
$env:PATH = "C:\Users\Arshia\AppData\Local\Android\Sdk\platform-tools;C:\Program Files\nodejs;" + $env:PATH

node --test test/            # expect: tests 44, pass 44, fail 0
node src\cli.mjs readiness    # exit 1 is expected here until hardware exists
```

Do not "fix" the failing readiness checks by weakening them. They are the point.

## 1. Mission and definition of done

**Mission.** A secretary agent speaks Persian to a real Iranian mobile or landline
through the SIM in a local Android phone, hears the answer, and continues the
conversation — with no telephony API, no SIP trunk, no per-minute platform fee
(normal carrier charges still apply).
The phone's own dialer places the call (ADB presses the buttons); the PC supplies
TTS and STT. Design reference: [SIMVox-AI](https://github.com/Magraa/SIMVox-AI)
(MIT).

**Done means all of this, in this order:**

1. `node --test test/` still passes (count in `README.md` §11 stays in sync).
2. `node src\cli.mjs readiness` reports `ready to dial: yes` **and**
   `ready to talk: yes` on the target machine.
3. `node src\cli.mjs selftest` returns three `OK` steps and `heard: true` with the
   real phone audio route, not with acoustic echo.
4. One real call to an allowlisted number: a human on the far end confirms they
   heard a Persian sentence produced by this repo, and `phone_listen` returns
   text that matches what that human actually said (compare with them; do not
   grade the transcript against your hopes).
5. `tools/phone-bridge/VERIFICATION.md` records every level with date, command,
   raw JSON (numbers masked), and any failure.
6. `README.md` §1 was updated to match what you proved — and still states what you
   did **not** prove.

If a step is impossible in your environment, the deliverable is an honest blocked
report, not a simulated success. A passing `selftest` is **necessary but not
sufficient**: it can pass through speakers/mic without ever touching the phone.

## 2. State of the project as of 2026-11-23

Verified on this machine today:

| Fact | Evidence |
| --- | --- |
| 44/44 offline tests pass | `node --test test/` |
| the agent passes the **call benchmark** on real code paths | `node bench/run.mjs --label=sweep2` → `bench/RESULTS.md` |
| end-of-turn capture implemented and tested | `test/listen-vad.test.mjs` |
| Real test numbers found and validated | `REAL-NUMBERS.md`; `09377000000` (Irancell support) is the only one in 11-digit national form that the validator accepts; `9990`/`700`/`200`/`118` are short codes and are rejected by design |
| Cheapest brain that passes the benchmark | `bench/RESULTS.md` winner row — pinned via `agent.model` in `phone.config.json`; the voice path itself is free |
| `adb` is runnable | `readiness` check `adb: OK  adb is runnable (adb.exe)` |
| No phone attached | `adb devices -l` prints an empty list |
| Only English SAPI voices | `Microsoft David Desktop (en-US)`, `Microsoft Zira Desktop (en-US)` |
| Persian through SAPI is silence | a Persian utterance yields a valid **46-byte** WAV; the bridge returns `code: "tts-silent-output"` |
| Capture backend is MCI | `audio: OK  capture backend: mci` |
| Only onboard audio endpoints | `Microphone (2- High Definition Audio Device)`, `Speakers (2- High Definition Audio Device)` — neither looks like a phone link |
| No STT engine | `stt: FAIL  no local speech-to-text engine configured` |
| Dialing not approved | `approval: FAIL  real dialing is blocked until PHONE_ALLOW_DIAL=1` |

Not verified anywhere yet (do not claim these):

- a real call ringing, being answered, and connecting on a carrier;
- the phone's call audio reaching the PC and the PC's voice reaching the human;
- Bluetooth HFP routing on this PC;
- Persian STT accuracy on 8–16 kHz phone audio;
- whether end-of-turn chunked capture (`PHONE_LISTEN_UNTIL_SILENCE`) behaves
  acceptably on a real route — MCI spawns a recorder per 2 s chunk, and those
  gaps may clip word tails; only synthetic-WAV offline behaviour is proven;
- whether `telecom end-call` works on the target phone's ROM (fallback is
  `input keyevent 6`, which needs the dialer in the foreground);
- whether the phone lets `am start` dial with the screen off (many ROMs block
  background activity launch).

The previous session ended here deliberately. Your job is to move this table, not
to rewrite it from memory.

## 3. Non-negotiable rules

1. **No third-party telephony service.** No Kavenegar/Asanak/Twilio/SIP/cloud
   call APIs, no VoIP aggregator. The SIM in the phone is the carrier. This is
   unchanged: Aval.ai carries **voice audio**, never the call.
2. **Voice path (amended by the owner on 2026-11-27).** The original rule was
   "keep TTS/STT local". The owner then asked explicitly for the best Persian
   call capability **from the Aval.ai model list**, because the local route could
   not be proven on this machine (no fa Windows voice, the vendored Piper binary
   rejects the `aɪ` phoneme, whisper was never downloaded). So:
   `PHONE_TTS_ENGINE=aval` / `PHONE_STT_ENGINE=aval` (`src/local/aval.mjs`) is the
   sanctioned route, measured by `bench/voice/` against real recorded Persian
   speech. Conditions that keep the spirit of the old rule:
   * every turn is priced from the model's own rate and a call stops at
     `PHONE_AVAL_BUDGET_USD` (default $0.05) with `voice-budget-exceeded`;
   * the key is read from config and redacted from every log and error;
   * audio formats are limited to `wav`/`pcm`, so no transcoder runs mid-call;
   * local engines (`sapi`, `cmd`) stay implemented and remain the default when
     the operator has no key — the cloud path must never be silently required.
   The LLM brain and now the voice path are the networked components; telephony
   is not.
3. **No spend without explicit approval.** Ask the human before buying hardware,
   credits, or a paid model. Downloading an open model is not spend, but say the
   size and licence first.
4. **Evidence or it did not happen.** Never write "works" without the command and
   its output. Mask real numbers (`0912***4567`) and never commit a real
   transcript.
5. **Never weaken a gate to make a test pass.** `PHONE_ALLOW_DIAL`,
   `PHONE_ALLOWLIST`, `PHONE_MAX_CALLS`, one-session, and the empty-audio guards
   are safety features. An agent must not be able to call a person on its own.
6. **Benchmark parity.** With `PHONE_TOOL` unset, `vanilla.mjs` must send the
   exact original five tools and system prompt. A test asserts this; keep it.
7. **Return data, not exceptions.** Every bridge function returns `{ok, code,
   error, hint}` so the ReAct loop can adapt. Keep that shape.
8. **Do not commit or push unless the human asks.** All phone-bridge work is
   currently uncommitted; treat the working tree as the only copy.
9. **Do not touch `benchmark/` results.** No re-running the 17-task matrix with
   `PHONE_TOOL=1`; simulated D tasks are the benchmark, real calls are a separate
   manual exercise.
10. **Docs are part of the product.** If you change a code, gate, count or
    command, update `README.md` in the same change.

## 4. Architecture you are extending

```
Vanilla agent (PHONE_TOOL=1)
  └─ phone_call / phone_say / phone_listen / phone_status / phone_hangup
       └─ tools/phone-bridge/src/index.mjs   ← gates, session, audit
            ├─ local/adb.mjs     control plane: am start CALL, dumpsys, telecom end-call
            ├─ local/tts.mjs     SAPI or PHONE_TTS_CMD  → WAV
            ├─ local/audio.mjs   MCI (default devices) or ffmpeg (named devices) → play/record
            ├─ local/wav.mjs     decode / resample / silence detection (pure JS)
            └─ local/stt.mjs     PHONE_STT_CMD → stdout text
```

| Plane | Mechanism | What it can and cannot do |
| --- | --- | --- |
| Control | ADB over USB or wireless | Presses dial/hangup and reads call state. Cannot carry voice. |
| Media | Bluetooth HFP, 3.5 mm TRRS + USB sound card, or USB audio | Windows must see the phone as an ordinary playback+recording device. |
| Data | `.tmp/phone-bridge/calls.jsonl`, `session.json`, `calls/<id>.json` | Audit, live session, archived transcript. Gitignored. |

Session states: `IDLE` → `PREVIEW` (dry run) / `SIMULATED` / `IN_CALL` → `IDLE`
(with an archive). Only one live session may exist; a second dial is refused with
`call-in-progress`.

**Important correction to check:** `README.md` §4.2 lists VB-CABLE as a phone
route. A virtual cable is a loopback **inside Windows**; it does not reach a phone
by itself. Treat it as a software test harness, not as a phone link, unless the
human has an actual phone-side companion app and confirms the topology. Fix the
wording once you know the real rig.

## 5. The verification ladder

Climb in order. Each level has a command, a pass criterion and an evidence line
for `VERIFICATION.md`. Do not skip to L5. A baseline dated 2026-11-23 (L0 PASS,
the rest BLOCKED/FAIL) already exists there; update it in place, never delete the
failed rows.

**L0 — offline correctness (no hardware)**

```powershell
node --test test/
```

Pass: 44/44. Evidence: the summary block (`tests 44 … fail 0`).

**L1 — ADB sees an authorized phone**

```powershell
adb devices -l
node src\cli.mjs devices
```

Pass: one line ending in `device` (not `unauthorized`, not `offline`), and the CLI
prints `state: CONNECTED`, a model, battery and carrier. Evidence: both outputs
with the serial masked.

**L2 — a real audio route exists in Windows**

```powershell
node src\cli.mjs audio
```

Pass: the endpoint that belongs to the phone appears, ideally marked
`[looks like a phone link]` (Bluetooth Hands-Free / USB Audio / a headset jack via
USB sound card). Evidence: endpoint names plus `backend:`.

**L3 — Persian TTS is audible on that route**

```powershell
node src\cli.mjs voices          # no fa-IR voice? install one, or use PHONE_TTS_ENGINE=cmd
node src\cli.mjs selftest        # steps tts + play must be OK
```

Pass: a human in the room hears the sentence **through the phone route**, and the
WAV is not 46 bytes. Evidence: `selftest --json` with `steps[0..1].ok = true`,
plus `PHONE_KEEP_AUDIO=1` size/duration if useful. With Bluetooth HFP this may be
impossible before a call exists (trap 5); in that case L5 is the proof.

**L4 — capture actually hears the phone**

```powershell
$env:PHONE_KEEP_AUDIO = "1"
node src\cli.mjs selftest --seconds 5
```

Pass: `record: OK`, `RMS` well above `PHONE_MIN_RMS` (0.004), and the retained WAV
contains the phrase when played back. Evidence: the WAV's path, duration, RMS, and
what you heard. Delete the WAV afterwards unless it is a masked test fixture.

**L5 — two-way real call (the only proof that counts)**

```powershell
$env:PHONE_ALLOWLIST  = "<your own number or a second phone>"
$env:PHONE_MAX_CALLS  = "1"
$env:PHONE_ALLOW_DIAL = "1"

node src\cli.mjs readiness                 # both lines must say yes
node src\cli.mjs call --to <number> --greeting "سلام، این یک تماس آزمایشی از طرف دفتر است."
node src\cli.mjs listen --seconds 8        # ask the human to say a known sentence
node src\cli.mjs say --text "بله، متوجه شدم. ممنون."
node src\cli.mjs hangup
```

Pass: the human confirms the greeting and reply were intelligible Persian; the
`listen` output is close to the sentence they actually said; `hangup` reports
`hung-up` and an archive path. Evidence: `call.id`, the mode (`live`, not
`simulate`), masked transcript, human's confirmation, archive filename.

**L6 — repeatability (optional but valuable)**

Two more calls to the same allowlisted number, with `PHONE_MAX_CALLS=3`. Pass:
no manual ADB intervention, no stale session, consistent latency. Evidence: three
`call.id`s and their durations. Note that the default cap is 3 real dials/hour
counted from the audit log, so leftover test dials can block you (`call-cap`).

## 6. Hardware bring-up checklist

`[HUMAN]` = only the owner can do it; ask, don't fake it.

1. `[HUMAN]` Phone with a working SIM and credit. Any Android with a dialer; no
   root. Note which SIM is default if the phone is dual-SIM — this bridge cannot
   choose a slot.
2. `[HUMAN]` Enable Developer options (tap Build number 7×) → USB debugging →
   connect USB → accept the RSA prompt.
3. Run L1. If `unauthorized`, re-accept the prompt or `adb kill-server`.
4. Choose the media route with the human:
   - **3.5 mm TRRS splitter + USB sound card** — most deterministic, works on
     almost every phone with a jack. Recommended first.
   - **Bluetooth HFP** — pair phone and PC; Windows exposes a Hands-Free device.
     Only routes audio while the phone is in a call, and sounds like a car kit.
   - **USB audio / vendor app** — device-specific; verify before relying on it.
   - **VB-CABLE** — PC-internal loopback; *not* a phone link by itself.
5. `[HUMAN]` Make the phone-side endpoints the Windows **default** playback and
   recording devices, because MCI always uses the defaults. If ffmpeg is
   installed, `PHONE_AUDIO_BACKEND=ffmpeg` + `PHONE_AUDIO_INPUT="<exact name>"`
   can capture from a named device, but **playback still uses MCI/SoundPlayer
   unless `PHONE_PLAY_CMD` is set**.
6. Run L2. If the device is missing, fix Windows/Bluetooth before touching code.
7. Persian voice: either install the Windows Persian speech pack (may not exist
   for fa-IR on this Windows build) or install Piper/eSpeak-NG and set **both**:

   ```powershell
   $env:PHONE_TTS_ENGINE = "cmd"
   $env:PHONE_TTS_CMD    = 'C:\tools\piper\piper.exe --model C:\tools\piper\fa_IR-amir-medium.onnx --output_file "{out}" --input_file "{text_file}"'
   ```

   Setting `PHONE_TTS_CMD` without `PHONE_TTS_ENGINE=cmd` does nothing — a trap.
8. Run L3, then L4.
9. STT: install whisper.cpp and point `PHONE_STT_CMD` at it, e.g.
   `C:\tools\whisper\whisper-cli.exe -m C:\tools\whisper\ggml-base.bin -l fa -nt -f "{wav}"`.
   Base is fast but weak on phone audio; try `small` if the CPU allows. It must
   print the transcript on stdout and exit 0.
10. `readiness` must say `ready to dial: yes` / `ready to talk: yes`.
11. Set a one-number allowlist, `PHONE_MAX_CALLS=1`, then L5 with the human
    holding the far end.
12. Only after L5, write `VERIFICATION.md` and update `README.md` §1.

PowerShell environment variables die with the window. If you need them across
commands, use one shell session, or a gitignored `phone.config.json` +
`PHONE_CONFIG` (environment wins over the file).

## 7. Contract you must not break

### Public API (`src/index.mjs`)

| Function | Success | Main failure codes |
| --- | --- | --- |
| `dial({to, greeting, dryRun, allowDial, config, deps})` | `in-call`, `simulated-call`, `dry-run` | `invalid-number`, `text-too-long`, `call-in-progress`, `dial-not-approved`, `not-allowlisted`, `call-cap`, `dial-failed`, `no-device`, `no-answer` |
| `say({text})` | `{ok:true, chars, voice, engine}` | `no-active-call`, `empty-text`, `text-too-long`, `tts-silent-output`, `tts-not-configured`, `voice-not-found`, playback errors |
| `listen({seconds, untilSilence})` | `{text, empty, hasSpeech, stt, vad}` — always `ok:true` when recording worked; `vad` is non-null only when end-of-turn capture ran | `no-active-call`, `call-ended`, `audio-*`, `empty-audio`; STT absence is reported, not thrown |
| `status()` | reconciles live telephony state; archives a call ended on the phone | — |
| `hangup()` | `hung-up`, archive path, transcript | `no-active-call` is still `ok:true` |
| `readiness()` | `{readyToDial, readyToTalk, checks[]}` | exit 1 in the CLI when not ready |
| `selftest({seconds})` | `{ok, steps[], heard}` | returns `ok:false` with the failing step |

`deps` injection is how tests avoid hardware: `{dial, hangup, callState,
deviceStatus, synthesize, play, record, transcribe, listVoices, listAudio,
audioBackend}`. Keep it.

### Configuration (env first, `PHONE_CONFIG` second)

Gates: `PHONE_ALLOW_DIAL`, `PHONE_ALLOWLIST`, `PHONE_MAX_CALLS`,
`PHONE_DRY_RUN`, `PHONE_SIMULATE`, `PHONE_SCRIPT`, `PHONE_ANNOUNCE_AI`,
`PHONE_MAX_TEXT`, `PHONE_LISTEN_SECONDS`, `PHONE_KEEP_AUDIO`, `PHONE_AUDIT_DIR`.

Turn-taking: `PHONE_LISTEN_UNTIL_SILENCE` (chunked end-of-turn capture),
`PHONE_SILENCE_MS` (trailing silence that ends a turn, default 1200).

Agent brain: `PHONE_AGENT_MODEL` (or `phone.config.json → agent.model`), read by
`benchmark/adapters/vanilla.mjs` only under `PHONE_TOOL=1`. Model resolution
order: `BENCH_MODEL` > `PHONE_MODEL` > config `agent.model` > matrix model.

ADB: `ADB_PATH`, `ADB_DEVICE_SERIAL`, `ADB_WIRELESS`, `ADB_TIMEOUT_MS`.

Audio/TTS/STT: `PHONE_AUDIO_BACKEND` (`auto|ffmpeg|mci|none`), `PHONE_AUDIO_INPUT`,
`PHONE_AUDIO_OUTPUT` (informational; MCI ignores it), `FFMPEG_PATH`,
`PHONE_PLAY_CMD`, `PHONE_SAMPLE_RATE`, `PHONE_MIN_RMS`, `PHONE_TTS_ENGINE`
(`sapi|cmd`), `PHONE_TTS_VOICE`, `PHONE_TTS_RATE`, `PHONE_TTS_CMD`,
`PHONE_STT_CMD`, `PHONE_STT_LANGUAGE`, `PHONE_STT_TIMEOUT_MS`.

Templates are **argv**, split with quote awareness and spawned directly — no
`cmd.exe`, no shell expansion, no injection from transcript text. Placeholders:
`{out}`, `{text_file}`, `{text}` (TTS), `{wav}`, `{language}`, `{out}` (STT),
`{wav}` (play). They must finish and write the file before exiting.

CLI exit codes: `0` ok, `1` error, `2` blocked by a gate.

### Files and numbers

`README.md` says **44 tests**; update that number and §12 whenever tests change.
Audit lives in `.tmp/phone-bridge/`; `phone.config.json` is gitignored. Numbers:
Iranian mobile `09xxxxxxxxx`, landline `0[1-8]xxxxxxxxx`, accepts `+98`, `0098`,
`98`, bare national, Persian/Arabic digits, spaces and dashes.

## 8. Traps that already bit this project

1. **English SAPI + Persian = a valid 46-byte WAV that reports success.** Never
   play it. `tts.mjs` now detects it (`tts-silent-output`); `audio.play` also
   refuses empty WAVs (`empty-audio`). Keep both guards.
2. **`PHONE_TTS_CMD` alone is not enough.** `readiness` and `synthesize` only use
   the command when `PHONE_TTS_ENGINE=cmd`.
3. **MCI always uses Windows default devices** and cannot `set format` on this
   machine (`rc=259/282`). Don't try to "fix" it; change the default or use
   ffmpeg for capture and `PHONE_PLAY_CMD` for playback.
4. **`PHONE_AUDIO_BACKEND=ffmpeg` does not redirect playback.** It only changes
   capture. This surprises people setting up VB-Cable.
5. **Bluetooth HFP needs an active call.** Before dialing, the Hands-Free device
   may not expose audio, so `selftest` can legitimately fail on a working rig.
   Test during a call, or trust L5 instead.
6. **Acoustic echo is a false positive.** `selftest` can pass through speakers and
   the room mic without touching the phone. L5 is the only proof.
7. **`am start` may be blocked with the screen off** on Android 10+. Keep the
   phone unlocked/foregrounded and check the dialer; do not conclude the SIM is
   dead. This is ROM-specific and unverified here.
8. **`telecom end-call` can fail silently**; the fallback `keyevent 6` requires
   the in-call UI. If `hangup` says `could not confirm`, check the phone before
   dialing again.
9. **A stale `session.json` blocks every dial** with `call-in-progress`. Inspect
   `node src\cli.mjs status`; if the phone is idle, deleting the file is safe.
10. **`PHONE_SIMULATE=1` can leak into a "real" test.** The result then says
    `simulated-call` and `simulated:true`; the audit marks it too. Check `mode`
    in `readiness --json` (must be `live`) before claiming a real call.
11. **The call cap is global and rolling**, counted from the audit log
    (`dial` + `ok` + not simulated + not a dry run, last hour). Old real test
    dials can block you; previews cannot (fixed and covered by a regression test).
12. **The Vanilla tool-result cap is 2000 chars.** `phoneResult()` drops
    `transcript`/`archive`/`preview` rather than cutting JSON, so the model never
    gets invalid JSON. If an agent needs the full transcript, write it to a file.
13. **Long phone text fails** (`text-too-long`, 1200 chars). One or two sentences
    per turn; that is also better on a real call.
14. **`PHONE_KEEP_AUDIO=1` is your debugging friend** for TTS/record WAVs in
    `%TEMP%`; unset it afterwards so calls don't leave audio behind.
15. **Numbers in git history are forever.** Use `09121234567` in tests/docs;
    mask everything from a real call.
16. **The benchmark D tasks are English and simulated.** `PHONE_TOOL=1` is for
    real manual calls. Don't wire real dialing into `benchmark/run.mjs`.
17. **Installing ffmpeg can break a working MCI setup.** `PHONE_AUDIO_BACKEND=auto`
    prefers ffmpeg, but ffmpeg capture needs `PHONE_AUDIO_INPUT`; without it,
    `listen` fails with `audio-input-missing`. Set the backend explicitly once the
    route is known.
18. **`readiness` does not exercise `PHONE_PLAY_CMD`.** A broken custom player
    still reports `ready to dial: yes`; only `selftest`/`say` will fail. Test the
    player before a real call.
19. **`listen --seconds 1` still records 2 seconds** (the minimum). Don't tune
    turn latency below that; with `PHONE_LISTEN_UNTIL_SILENCE=1` the window
    still starts at 2 s chunks — the flag saves the *dead* seconds, it cannot
    invent speech faster than the recorder runs.
20. **Carrier short codes are not phone numbers here.** `9990`, `700`, `200`,
    `118` fail `normalizeIranNumber` (`invalid-number`, 8-digit / short forms)
    by design; support *is* reachable via the 11-digit forms
    (`09377000000` = Irancell from any line). See `REAL-NUMBERS.md` before
    promising a call to a short code.
21. **The benchmark runner must re-import the adapter per model.**
    `PHONE_ENABLED`/`MODEL_ID` are resolved at module load; a cached import
    silently runs the previous model. `bench/run.mjs` busts the cache with a
    query nonce — a TDZ ordering bug in `vanilla.mjs` (referencing
    `PHONE_ENABLED` before its declaration) produced a whole column of
    `Cannot access before initialization` rows in sweep1; the fix and the
    re-run are the audit trail in `bench/results/`.

22. **ElevenLabs through Aval serves mp3 only.** Asking for `wav`/`pcm` on
    `/audio/speech` returns **HTTP 503**, not a format error, so it reads like an
    outage (measured across v3/v4/v4_turbo/multilingual/flash on 2026-11-27). Gemini
    voices return a real WAV header; `tts-1` intermittently 400s. The bridge accepts
    `wav`/`pcm`/`mp3` and decodes mp3 with the vendored ffmpeg — if that binary is
    missing you get `tts-needs-transcoder`, never a garbage file played into a call.
23. **A 429 is not a model verdict.** Audio models here are capped per tier (as low
    as **3 requests/minute**), so an unpaced sweep records a whole model as "failed"
    while it was only throttled. `tts-bench`/`stt-bench` are resumable
    (`results/{stt,tts}-parts/`) and pace with `--pace`; `report.mjs` labels throttled
    models `unmeasured (rate-limited)` instead of failing them.
24. **The catalogue lies in both directions.** `gpt-transcribe` is listed with
    `mode: audio_transcription` yet the endpoint rejects it ("not supported by
    /v1/audio/transcriptions"), and `groq.playai-tts` is listed while answering 404
    deprecated. Trust only a live call — `bench/voice/formats.mjs` and
    `bench/voice/catalog.mjs` exist for exactly that.
25. **Speech is the expensive part; price the plan before running it.** The STT sweep
    over 20 real clips cost ≈ $0.06; the TTS sweep cost ≈ $0.63, because ElevenLabs
    bills per second of *generated* audio and the test sentences run 6–13 s each.
    `bench/voice/final-check.mjs` refuses to send anything whose planned total exceeds
    `--max-usd`, and `bench/voice/spend.mjs` recomputes the bill from artifacts, so
    "about a dollar" never has to be guessed at.

## 9. Backlog, in priority order

### P0 — finish the verification ladder (blocks everything else)

Do §5 and §6. Create `tools/phone-bridge/VERIFICATION.md`:

```markdown
# Verification log

Environment: Windows <ver>, Node <ver>, adb <ver>, phone <model/ROM>, route <name>.
Last updated: <date>.

| Level | What it proves | Result | Evidence (masked) | Notes |
| --- | --- | --- | --- | --- |
| L0 tests | code correctness offline | PASS/FAIL | `tests 44 … fail 0` | |
| L1 adb | phone authorized | | `adb devices -l` line | |
| L2 route | phone audio visible in Windows | | endpoint names | |
| L3 tts | Persian audible on the real route | | `selftest` steps 0–1 | |
| L4 capture | the route hears the phone | | RMS, WAV duration | |
| L5 call | two-way intelligible Persian | | call.id, masked transcript | human confirmation |
```

Acceptance: every row has a real result; failures say what is missing. Then update
`README.md` §1 and §13 so they match, and fix the VB-CABLE wording in §4.2 if it
is still misleading.

### P1 — make the audio path observable (small, offline-testable)

`selftest` proves TTS/play/record but not STT. Add an optional transcription step
(and a `--stt` flag / `selftest({stt:true})`) that runs `PHONE_STT_CMD` on the
recorded WAV and returns `{ text, stt: {ok, code} }`. Acceptance: offline test with
an injected `transcribe` and an injected recorder; CLI prints the text; when STT
is unconfigured the step is `SKIP`, not `FAIL`. Update README §9 and the test
count.

### P1 — Persian conversation guidance for real calls (opt-in only)

The `PHONE_TOOL=1` prompt section is English and tells the model to be brief, but
not to speak Persian or handle Iranian phone etiquette. Add an opt-in
`PHONE_LANGUAGE=fa` block (or `PHONE_PROMPT`) with: greet with the office name,
one short sentence per turn, confirm numbers/dates back, never invent a caller's
identity, end politely. It must be off by default and must not change the
benchmark D tasks (English, simulated). Acceptance: parity test still passes with
the flag unset; a live call uses Persian naturally.

### P2 — end-of-turn detection instead of fixed windows — **DONE (2026-11-23)**

Implemented: `PHONE_LISTEN_UNTIL_SILENCE=1` records in 2 s chunks, stops once
the caller has been quiet for `PHONE_SILENCE_MS` (default 1200) and caps pure
dead air at 4 s, joining chunks via `wav.mjs` (`trailingSilenceMs`,
`concatWavFiles`). Default fixed-window behaviour is unchanged (`listen` without
the flag is byte-identical). Offline proof: `test/listen-vad.test.mjs` (5 tests,
synthetic loud/silent WAVs). CLI: `node src/cli.mjs listen --until-silence`.
Still unproven on a real route — see §2 "not verified".

### P2 — platform truth in `readiness`

`audioBackend` returns `mci` on Windows even with no phone route (it only checks
the backend, not the endpoints). Consider adding a non-blocking check: if no
endpoint looks like a phone link and MCI is the backend, mark the check `warn`
(or add `readyToTalk: false` reasoning). Do not turn it into a hard failure —
onboard audio can be a valid route through a splitter. Acceptance: unit test with
injected endpoints; `readiness` message names the actual problem.

### P3 — decide with the human, don't build unasked

- inbound calls (`adb answer` exists but is not exposed);
- dual-SIM slot selection;
- call recording for audit (legal/consent questions);
- quiet hours and per-number policy;
- a second line / concurrent calls (the current design is one call, on purpose).

**Do not build:** cloud telephony, WhatsApp/Telegram calling, bulk dialing,
"answering machine" detection, or anything that removes `PHONE_ALLOW_DIAL`.

## 10. Quality commands and what to paste back

```powershell
cd E:\home_works\my_secretary\tools\phone-bridge
$env:PATH = "C:\Users\Arshia\AppData\Local\Android\Sdk\platform-tools;C:\Program Files\nodejs;" + $env:PATH

node --test test/
node bench/run.mjs --label=sweep                     # model/cost sweep → bench/RESULTS.md
node src\cli.mjs readiness --json
node src\cli.mjs devices --json
node src\cli.mjs audio --json
node src\cli.mjs voices --json
node src\cli.mjs selftest --json
node src\cli.mjs log --limit 10
```

Report back with:

1. the L0–L6 table and the exact commands you ran;
2. `readiness --json` (mode must be `live` for a real call);
3. the L5 `call.id`, masked transcript, and the human's confirmation;
4. every file you changed and every doc number you changed (test count, §1);
5. what is still unverified, in the same blunt language as this document.

If hardware is unavailable to you, say so at the top and deliver P1/P2 code plus
an honest `VERIFICATION.md` with `BLOCKED (no hardware)` rows. That is a valid
outcome. A fabricated "PASS" is not.

## 11. Questions to ask the human before big moves

1. Which audio route can you provide/buy: 3.5 mm TRRS splitter + USB sound card,
   Bluetooth HFP, or USB audio? (A purchase needs approval.)
2. Which number(s) may the secretary call, and in which hours? Put them in
   `PHONE_ALLOWLIST`.
3. Persian voice: install a Windows speech pack, or run Piper with a fa_IR model?
4. STT: which whisper.cpp model size can this CPU run in near real time?
5. Is inbound calling in scope, or outbound only?
6. May I commit the current uncommitted work (and on which branch)?

## 12. If you only have two hours

Run L0, L1, L2/L3 (or mark them BLOCKED), write `VERIFICATION.md` with the truth,
fix the VB-CABLE wording, and stop. Do not touch the gates, do not refactor, and
do not claim a call worked. The next agent will thank you for a baseline it can
trust.
