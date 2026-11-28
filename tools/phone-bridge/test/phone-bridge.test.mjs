// Offline tests: no network, no phone, no audio hardware, no credentials.
// Real ADB is replaced by an injected runner and real TTS/STT by injected
// functions; the simulator exercises the full conversation loop.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeIranNumber } from "../src/numbers.mjs";
import { dial, hangup, listen, readiness, say, status } from "../src/index.mjs";
import { readCallRecords, readSession } from "../src/store.mjs";
import { buildAdbArgs, buildDialArgs, buildHangupArgs, deviceStatus, getCallState, parseCallState, parseDevices } from "../src/local/adb.mjs";
import { decodeWav, encodeWav16, probeWav, resample } from "../src/local/wav.mjs";
import { splitCommand } from "../src/local/shell.mjs";
import { cleanTranscript } from "../src/local/stt.mjs";
import { looksPersian, pickVoice } from "../src/local/tts.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phone-bridge-test-"));

function testConfig(overrides = {}) {
  const auditDir = fs.mkdtempSync(path.join(tmpRoot, "audit-"));
  const base = {
    simulate: false,
    dryRun: false,
    allowDial: false,
    allowlist: [],
    maxCallsPerRun: 3,
    timeoutMs: 5000,
    dialTimeoutMs: 5000,
    answerTimeoutMs: 5000,
    listenSeconds: 2,
    maxListenSeconds: 30,
    maxText: 1200,
    announceAi: true,
    keepAudio: true,
    auditDir,
    sessionFile: path.join(auditDir, "session.json"),
    script: [],
    adb: { path: "adb", serial: "", wireless: "", timeoutMs: 5000 },
    audio: { backend: "none", inputDevice: "", outputDevice: "", ffmpeg: "ffmpeg", sampleRate: 16000, minRms: 0.004, playCmd: "" },
    tts: { engine: "sapi", voice: "", rate: 0, command: "" },
    stt: { command: "", language: "fa", timeoutMs: 5000 },
  };
  return {
    ...base,
    ...overrides,
    adb: { ...base.adb, ...(overrides.adb || {}) },
    audio: { ...base.audio, ...(overrides.audio || {}) },
    tts: { ...base.tts, ...(overrides.tts || {}) },
    stt: { ...base.stt, ...(overrides.stt || {}) },
  };
}

function fakeDeps(overrides = {}) {
  const calls = { dial: 0, hangup: 0, synthesize: 0, play: 0, record: 0, transcribe: 0 };
  const fakeWav = path.join(tmpRoot, "fake.wav");
  if (!fs.existsSync(fakeWav)) fs.writeFileSync(fakeWav, encodeWav16(new Float32Array(800), 8000));

  const deps = {
    deviceStatus: async () => ({ ok: true, state: "CONNECTED", serial: "PHONE1", model: "Pixel 7", devices: [], hint: null }),
    dial: async () => {
      calls.dial += 1;
      return { ok: true, code: "in-call", state: "IN_CALL", answered: true, device: { serial: "PHONE1", model: "Pixel 7" } };
    },
    hangup: async () => {
      calls.hangup += 1;
      return { ok: true, code: "hung-up", state: "IDLE" };
    },
    callState: async () => ({ ok: true, state: "IN_CALL", device: { state: "CONNECTED", serial: "PHONE1", model: "Pixel 7" } }),
    synthesize: async (config, text) => {
      calls.synthesize += 1;
      return { ok: true, path: fakeWav, engine: "fake", voice: "Fake", culture: "fa-IR", warning: null, duration: 1, text };
    },
    play: async () => {
      calls.play += 1;
      return { ok: true, backend: "fake", duration: 1 };
    },
    record: async () => {
      calls.record += 1;
      return { ok: true, path: fakeWav, duration: 2, backend: "fake", rms: 0.08, hasSpeech: true, hint: null };
    },
    transcribe: async () => {
      calls.transcribe += 1;
      return { ok: true, text: "سلام، بله در خدمتم" };
    },
    listVoices: async () => ({ ok: true, voices: [{ name: "Fake Persian", culture: "fa-IR", gender: "Female" }], hasPersian: true }),
    listAudio: async () => ({ ok: true, endpoints: [], hint: null }),
    audioBackend: async () => "mci",
  };
  return { ...deps, ...overrides, calls };
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

test("normalizes every accepted Iranian number spelling", () => {
  const expected = "09121234567";
  for (const input of [
    "09121234567",
    "0912 123 4567",
    "0912-123-4567",
    "+989121234567",
    "+98 912 123 4567",
    "00989121234567",
    "989121234567",
    "9121234567",
    "۰۹۱۲۱۲۳۴۵۶۷",
    "٠٩١٢١٢٣٤٥٦٧",
  ]) {
    const result = normalizeIranNumber(input);
    assert.equal(result.ok, true, `expected ${input} to parse`);
    assert.equal(result.national, expected, input);
    assert.equal(result.e164, "+989121234567", input);
    assert.equal(result.kind, "mobile", input);
  }
});

test("normalizes landlines and rejects junk", () => {
  const tehran = normalizeIranNumber("021-1234-5678");
  assert.equal(tehran.ok, true);
  assert.equal(tehran.national, "02112345678");
  assert.equal(tehran.e164, "+982112345678");
  assert.equal(tehran.kind, "landline");

  assert.equal(normalizeIranNumber("").ok, false);
  assert.equal(normalizeIranNumber("hello").ok, false);
  assert.equal(normalizeIranNumber("0912123456").ok, false, "too short");
  assert.equal(normalizeIranNumber("00123456789").ok, false, "not an Iranian prefix");
});

test("parses adb devices, including unauthorized and emulators", () => {
  const devices = parseDevices(`List of devices attached
ABC123\tdevice product:panther model:Pixel_7 device:panther transport_id:1
DEF456\tunauthorized usb:1-2 transport_id:2
emulator-5554\tdevice product:sdk_gphone64 model:sdk_gphone64_x86_64 transport_id:3
`);
  assert.equal(devices.length, 3);
  assert.equal(devices[0].serial, "ABC123");
  assert.equal(devices[0].model, "Pixel 7");
  assert.equal(devices[0].state, "device");
  assert.equal(devices[1].state, "unauthorized");
  assert.equal(devices[2].isEmulator, true);
});

test("parses call state from telephony.registry and telecom", () => {
  assert.equal(parseCallState("mCallState=0"), "IDLE");
  assert.equal(parseCallState("mCallState=1"), "RINGING");
  assert.equal(parseCallState("mCallState=2"), "IN_CALL");
  assert.equal(parseCallState("State: RINGING"), "RINGING");
  assert.equal(parseCallState("State: ACTIVE"), "IN_CALL");
  assert.equal(parseCallState("nothing useful"), "UNKNOWN");
});

test("builds the documented ADB commands", () => {
  const config = testConfig({ adb: { serial: "ABC123" } });
  const number = normalizeIranNumber("09121234567");

  assert.deepEqual(buildDialArgs(config, number), [
    "-s",
    "ABC123",
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.CALL",
    "-d",
    "tel:+989121234567",
  ]);
  assert.deepEqual(buildHangupArgs(config), ["-s", "ABC123", "shell", "telecom", "end-call"]);
  assert.deepEqual(buildAdbArgs(config, "devices -l"), ["devices", "-l"], "global commands must not take -s");
});

test("deviceStatus explains a missing adb binary", async () => {
  const config = testConfig();
  const run = async () => ({ ok: false, code: 1, stdout: "", stderr: "not recognized" });
  const report = await deviceStatus(config, { run });
  assert.equal(report.state, "NO_ADB");
  assert.match(report.hint, /platform-tools|ADB_PATH/);
});

test("deviceStatus reports unauthorized phones distinctly", async () => {
  const config = testConfig();
  const run = async (file, args) => {
    if (args[0] === "version") return { ok: true, stdout: "Android Debug Bridge version 1.0.41", stderr: "" };
    if (args[0] === "devices") return { ok: true, stdout: "List of devices attached\nABC\tunauthorized usb:1\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const report = await deviceStatus(config, { run });
  assert.equal(report.ok, false);
  assert.equal(report.state, "UNAUTHORIZED");
  assert.match(report.hint, /Allow/);
});

test("getCallState reads the live registry", async () => {
  const config = testConfig();
  const run = async (file, args) => {
    if (args[0] === "version") return { ok: true, stdout: "version", stderr: "" };
    if (args[0] === "devices") return { ok: true, stdout: "List of devices attached\nABC\tdevice model:Pixel_7\n", stderr: "" };
    if (args.includes("telephony.registry")) return { ok: true, stdout: "mCallState=2", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const result = await getCallState(config, { run });
  assert.equal(result.ok, true);
  assert.equal(result.state, "IN_CALL");
});

test("WAV round-trip and resampling preserve duration", () => {
  const samples = new Float32Array(8000).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 8000) * 0.5);
  const buffer = encodeWav16(samples, 8000);
  const decoded = decodeWav(buffer);
  assert.equal(decoded.sampleRate, 8000);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.bitsPerSample, 16);
  assert.equal(decoded.samples.length, 8000);
  assert.ok(Math.abs(decoded.duration - 1) < 0.001);

  const upsampled = resample(decoded.samples, 8000, 16000);
  assert.equal(upsampled.length, 16000);
  assert.ok(Math.abs(upsampled[4000] - decoded.samples[2000]) < 0.01);
});

test("transcript cleaning strips timestamps and silence markers", () => {
  assert.equal(
    cleanTranscript("[00:00:00.000 --> 00:00:02.000]  سلام\n[00:00:02.000 --> 00:00:03.000]  خوبی؟\n[BLANK_AUDIO]"),
    "سلام خوبی؟",
  );
  assert.equal(cleanTranscript(""), "");
});

test("voice selection prefers a Persian voice and detects Persian text", () => {
  const voices = [
    { name: "Microsoft David Desktop", culture: "en-US" },
    { name: "Microsoft Dilara", culture: "fa-IR" },
  ];
  assert.equal(pickVoice("", voices).name, "Microsoft Dilara");
  assert.equal(pickVoice("david", voices).name, "Microsoft David Desktop");
  assert.equal(pickVoice("fa-IR", voices).name, "Microsoft Dilara");
  assert.equal(pickVoice("missing", voices), null);
  assert.equal(looksPersian("سلام"), true);
  assert.equal(looksPersian("hello"), false);
});

/** The exact 46-byte WAV that Windows SAPI writes when a voice cannot speak the text. */
function emptySapiWav(file) {
  const header = Buffer.alloc(46);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(38, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(18, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(44100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 38, "ascii");
  header.writeUInt32LE(0, 42);
  fs.writeFileSync(file, header);
  return file;
}

test("an empty WAV is detected, so silence is never mistaken for speech", () => {
  const empty = emptySapiWav(path.join(tmpRoot, "empty.wav"));

  const silent = probeWav(empty);
  assert.equal(silent.ok, true);
  assert.equal(silent.silent, true);
  assert.equal(silent.duration, 0);

  const real = path.join(tmpRoot, "real.wav");
  fs.writeFileSync(real, encodeWav16(new Float32Array(8000).fill(0.2), 8000));
  const studied = probeWav(real);
  assert.equal(studied.silent, false);
  assert.ok(studied.duration > 0.9);
});

test("playback refuses an empty WAV instead of playing silence", async () => {
  const empty = emptySapiWav(path.join(tmpRoot, "empty-play.wav"));
  const { play } = await import("../src/local/audio.mjs");
  const result = await play(testConfig(), empty);
  assert.equal(result.ok, false);
  assert.equal(result.code, "empty-audio");
});

test("splitCommand keeps quoted paths as single argv entries", () => {
  assert.deepEqual(splitCommand(`"C:\\Program Files\\node.exe" -m "models\\ggml base.bin" -f "{wav}"`), [
    "C:\\Program Files\\node.exe",
    "-m",
    "models\\ggml base.bin",
    "-f",
    "{wav}",
  ]);
  assert.deepEqual(splitCommand("  whisper   -l   fa  "), ["whisper", "-l", "fa"]);
  assert.deepEqual(splitCommand(""), []);
  assert.deepEqual(splitCommand('--flag="a b"'), ["--flag=a b"]);
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test("dry run validates and logs without touching adb, TTS or audio", async () => {
  const config = testConfig();
  const deps = fakeDeps();
  const result = await dial({ to: "۰۹۱۲۱۲۳۴۵۶۷", greeting: "سلام", dryRun: true, config, deps });

  assert.equal(result.ok, true);
  assert.equal(result.code, "dry-run");
  assert.equal(result.state, "PREVIEW");
  assert.equal(result.to.national, "09121234567");
  assert.equal(result.preview.greeting, "سلام");
  assert.equal(deps.calls.dial, 0);
  assert.equal(deps.calls.synthesize, 0);
  assert.equal(readSession(config), null);

  const [record] = readCallRecords(config, 5);
  assert.equal(record.event, "dial");
  assert.equal(record.dryRun, true);
});

test("dry runs never consume the real-dial budget", async () => {
  const config = testConfig({ allowDial: true, maxCallsPerRun: 1 });
  const deps = fakeDeps();

  for (let i = 0; i < 3; i += 1) {
    const preview = await dial({ to: "09121234567", dryRun: true, config, deps });
    assert.equal(preview.code, "dry-run");
  }
  assert.equal(deps.calls.dial, 0);

  const real = await dial({ to: "09121234567", config, deps });
  assert.equal(real.ok, true);
  assert.equal(deps.calls.dial, 1);
});

test("a real dial is blocked until the operator approves it", async () => {
  const config = testConfig();
  const deps = fakeDeps();
  const result = await dial({ to: "09121234567", greeting: "سلام", config, deps });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, "dial-not-approved");
  assert.equal(deps.calls.dial, 0, "adb must not run before approval");
});

test("the allowlist blocks every other destination", async () => {
  const config = testConfig({ allowDial: true, allowlist: ["+98 912 000 0000"] });
  const deps = fakeDeps();

  const blocked = await dial({ to: "09121234567", config, deps });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.code, "not-allowlisted");
  assert.equal(deps.calls.dial, 0);

  const allowed = await dial({ to: "09120000000", config, deps });
  assert.equal(allowed.ok, true);
  assert.equal(deps.calls.dial, 1);
});

test("the hourly call cap stops runaway dialing", async () => {
  const config = testConfig({ allowDial: true, maxCallsPerRun: 1 });
  const deps = fakeDeps();

  const first = await dial({ to: "09121234567", config, deps });
  assert.equal(first.ok, true);
  await hangup({ config, deps });

  const second = await dial({ to: "09121234567", config, deps });
  assert.equal(second.ok, false);
  assert.equal(second.code, "call-cap");
  assert.equal(deps.calls.dial, 1);
});

test("a second dial is refused while a session is open", async () => {
  const config = testConfig({ allowDial: true });
  const deps = fakeDeps();
  assert.equal((await dial({ to: "09121234567", config, deps })).ok, true);
  const again = await dial({ to: "09121234567", config, deps });
  assert.equal(again.blocked, true);
  assert.equal(again.code, "call-in-progress");
});

test("a device or dial failure is returned as data with a hint", async () => {
  const config = testConfig({ allowDial: true });
  const deps = fakeDeps({
    dial: async () => ({
      ok: false,
      code: "no-device",
      state: "DISCONNECTED",
      error: "no Android device",
      device: { hint: "connect the phone and accept the USB debugging prompt" },
    }),
  });
  const result = await dial({ to: "09121234567", config, deps });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-device");
  assert.match(result.hint, /USB debugging/);
});

// ---------------------------------------------------------------------------
// Conversation loop
// ---------------------------------------------------------------------------

test("a full call: greet, listen, reply, hang up, archive", async () => {
  const config = testConfig({ allowDial: true });
  const deps = fakeDeps();

  const placed = await dial({ to: "09121234567", greeting: "سلام، دفتر مدرسه تماس می‌گیرم.", config, deps });
  assert.equal(placed.ok, true);
  assert.equal(placed.state, "IN_CALL");
  assert.equal(placed.greeting.ok, true);
  assert.equal(placed.greeting.voice, "Fake");
  assert.equal(deps.calls.synthesize, 1);
  assert.equal(deps.calls.play, 1);

  const heard = await listen({ seconds: 3, config, deps });
  assert.equal(heard.ok, true);
  assert.equal(heard.text, "سلام، بله در خدمتم");
  assert.equal(heard.hasSpeech, true);
  assert.equal(deps.calls.record, 1);
  assert.equal(deps.calls.transcribe, 1);

  const reply = await say({ text: "خیلی خوب، پس فردا ساعت ده.", config, deps });
  assert.equal(reply.ok, true);
  assert.equal(reply.chars > 0, true);

  const live = await status({ config, deps });
  assert.equal(live.state, "IN_CALL");
  assert.equal(live.session.turns, 4, "AI disclosure + greeting + caller + reply");

  const ended = await hangup({ config, deps });
  assert.equal(ended.ok, true);
  assert.equal(ended.turns, 4);
  assert.ok(fs.existsSync(ended.archive), "transcript archive must exist");
  assert.equal(readSession(config), null);

  const archived = JSON.parse(fs.readFileSync(ended.archive, "utf8"));
  const callerTurns = archived.turns.filter((turn) => turn.speaker === "caller");
  assert.equal(callerTurns.length, 1);
  assert.equal(callerTurns[0].text, "سلام، بله در خدمتم");

  const events = readCallRecords(config, 20).map((record) => record.event);
  assert.deepEqual(events, ["dial", "listen", "say", "hangup"]);
});

test("listen reports silence and never invents a transcript", async () => {
  const config = testConfig({ allowDial: true });
  const deps = fakeDeps({
    record: async () => ({ ok: true, path: path.join(tmpRoot, "silent.wav"), duration: 3, backend: "mci", rms: 0.0001, hasSpeech: false, hint: "the recording is silent" }),
    transcribe: async () => ({ ok: false, text: "", code: "stt-not-configured", error: "no engine", hint: "set PHONE_STT_CMD" }),
  });
  await dial({ to: "09121234567", config, deps });
  const result = await listen({ config, deps });

  assert.equal(result.ok, true);
  assert.equal(result.text, "");
  assert.equal(result.empty, true);
  assert.equal(result.hasSpeech, false);
  assert.equal(result.stt.ok, false);
  assert.match(result.hint, /silent/);
});

test("say and listen refuse to run without an active call", async () => {
  const config = testConfig();
  const deps = fakeDeps();
  assert.equal((await say({ text: "hello", config, deps })).code, "no-active-call");
  assert.equal((await listen({ config, deps })).code, "no-active-call");
});

test("status reconciles a call that ended on the phone", async () => {
  const config = testConfig({ allowDial: true });
  let state = "IN_CALL";
  const deps = fakeDeps({ callState: async () => ({ ok: true, state, device: { state: "CONNECTED" } }) });

  await dial({ to: "09121234567", greeting: "سلام", config, deps });
  state = "IDLE";

  const result = await status({ config, deps });
  assert.equal(result.ok, true);
  assert.equal(result.state, "IDLE");
  assert.equal(result.code, "call-ended");
  assert.equal(readSession(config), null);

  const calls = fs.readdirSync(path.join(config.auditDir, "calls"));
  assert.equal(calls.length, 1);
});

test("simulation exercises the whole loop with a scripted caller", async () => {
  const config = testConfig({ simulate: true, script: ["سلام، بفرمایید.", "فردا ساعت ده خوبه."] });
  const deps = fakeDeps();

  const placed = await dial({ to: "09121234567", greeting: "سلام، دفتر مدرسه.", config, deps });
  assert.equal(placed.ok, true);
  assert.equal(placed.state, "SIMULATED");
  assert.equal(placed.scriptedTurns, 2);
  assert.equal(deps.calls.synthesize, 0, "simulation must not use the audio hardware");

  const first = await listen({ config, deps });
  assert.equal(first.text, "سلام، بفرمایید.");
  const second = await listen({ config, deps });
  assert.equal(second.text, "فردا ساعت ده خوبه.");
  const third = await listen({ config, deps });
  assert.equal(third.text, "");
  assert.equal(third.empty, true);

  const ended = await hangup({ config, deps });
  assert.equal(ended.ok, true);
  assert.equal(ended.turns, 4);
  const archived = JSON.parse(fs.readFileSync(ended.archive, "utf8"));
  assert.equal(archived.simulated, true);
});

// ---------------------------------------------------------------------------
// Engine integration (local, deterministic)
// ---------------------------------------------------------------------------

test("readiness reports missing hardware instead of pretending", async () => {
  const config = testConfig();
  const deps = fakeDeps({
    deviceStatus: async () => ({ ok: false, state: "DISCONNECTED", serial: null, model: null, devices: [], hint: "no Android device" }),
    listVoices: async () => ({ ok: true, voices: [{ name: "Microsoft David Desktop", culture: "en-US" }], hasPersian: false }),
    audioBackend: async () => "mci",
  });
  const report = await readiness({ config, deps });

  assert.equal(report.ok, false);
  assert.equal(report.readyToDial, false);
  const device = report.checks.find((check) => check.id === "device");
  assert.equal(device.ok, false);
  assert.match(device.hint, /Android device/);

  const tts = report.checks.find((check) => check.id === "tts");
  assert.equal(tts.ok, false, "an en-US voice cannot speak Persian, so TTS is not ready");
  assert.match(tts.hint, /Persian/);
  assert.ok(report.nextSteps.some((step) => /ANDROID|Android|PHONE_ALLOW_DIAL/i.test(step)));
});

test("readiness accepts a configured Persian-capable TTS engine", async () => {
  const config = testConfig({
    tts: { engine: "cmd", command: "piper.exe --model fa_IR.onnx --output_file {out}" },
    stt: { command: "whisper-cli.exe -m ggml-base.bin -l fa -f {wav}" },
  });
  const deps = fakeDeps({
    deviceStatus: async () => ({ ok: true, state: "CONNECTED", serial: "P1", model: "Pixel", devices: [], hint: null }),
    audioBackend: async () => "ffmpeg",
    listAudio: async () => ({ ok: true, endpoints: [{ name: "CABLE Output", likelyPhoneBridge: true }], hint: null }),
    listVoices: async () => ({ ok: true, voices: [], hasPersian: false }),
  });
  const report = await readiness({ config, deps });
  const tts = report.checks.find((check) => check.id === "tts");
  assert.equal(tts.ok, true);
  assert.equal(report.readyToDial, true);
  assert.equal(report.readyToTalk, true);
});

test("speech-to-text runs a real local command and reads stdout", async () => {
  const script = path.join(tmpRoot, "fake-stt.mjs");
  fs.writeFileSync(script, "process.stdout.write('[00:00:00.000 --> 00:00:01.000]  سلام از موتور محلی');", "utf8");
  const wav = path.join(tmpRoot, "stt-input.wav");
  fs.writeFileSync(wav, encodeWav16(new Float32Array(1600), 16000));

  const { transcribe } = await import("../src/local/stt.mjs");
  const config = testConfig({ stt: { command: `"${process.execPath}" "${script}" "{wav}"` } });
  const result = await transcribe(config, wav);

  assert.equal(result.ok, true);
  assert.equal(result.text, "سلام از موتور محلی");
});

test("speech-to-text without an engine is an explicit, actionable failure", async () => {
  const { transcribe } = await import("../src/local/stt.mjs");
  const config = testConfig();
  const result = await transcribe(config, path.join(tmpRoot, "missing.wav"));
  assert.equal(result.ok, false);
  assert.equal(result.code, "stt-not-configured");
  assert.match(result.hint, /PHONE_STT_CMD/);
});

test("audio capture without a backend explains the fix", async () => {
  const { record } = await import("../src/local/audio.mjs");
  const config = testConfig({ audio: { backend: "none" } });
  const result = await record(config, { seconds: 2, backend: "none" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "audio-unavailable");
  assert.match(result.hint, /ffmpeg|mci/);
});
