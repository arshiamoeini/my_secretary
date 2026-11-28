#!/usr/bin/env node
// Human entry point. The agent uses the library directly; this CLI is how you
// verify hardware, run a sound check and hold a conversation from a terminal.

import { loadConfig } from "./config.mjs";
import { normalizeIranNumber } from "./numbers.mjs";
import { audioEndpoints, dial, hangup, listen, readiness, say, selftest, status, voices } from "./index.mjs";
import { hear as avalHear, speak as avalSpeak } from "./local/aval.mjs";
import { deviceStatus, telemetry } from "./local/adb.mjs";
import { readCallRecords } from "./store.mjs";

const HELP = `phone-bridge - real phone calls through a phone's own SIM (no telephony API)

Usage:
  node src/cli.mjs readiness [--json]     check adb, phone, voices, audio, STT
  node src/cli.mjs devices [--json]       ADB devices + battery/carrier
  node src/cli.mjs audio [--json]         Windows audio endpoints and backend
  node src/cli.mjs voices [--json]        installed local TTS voices
  node src/cli.mjs voice [--probe]        resolved voice path (local or Aval) + optional live round-trip
  node src/cli.mjs normalize <number>     canonical Iranian number
  node src/cli.mjs selftest [--seconds 4] speak a phrase, then record it back

Call control:
  node src/cli.mjs call --to <number> [--greeting "words"] [options]
  node src/cli.mjs say --text "words"
  node src/cli.mjs listen [--seconds 8] [--until-silence]
  node src/cli.mjs status
  node src/cli.mjs hangup
  node src/cli.mjs log [--limit 20]

Call options:
  --dry-run       validate and log without dialing
  --simulate      scripted caller (PHONE_SCRIPT), no phone or audio needed
  --allow-dial    one-shot approval for a real call
  --json          machine-readable output

Key environment:
  PHONE_ALLOW_DIAL=1      required for real dialing
  PHONE_ALLOWLIST=...     restrict destinations
  PHONE_MAX_CALLS=3       max real dials per hour
  PHONE_LISTEN_UNTIL_SILENCE=1  end-of-turn capture (stop when caller is quiet)
  PHONE_SILENCE_MS=1200   trailing silence that ends a turn
  ADB_PATH, ADB_DEVICE_SERIAL, ADB_WIRELESS
  PHONE_AUDIO_BACKEND     auto | ffmpeg | mci | none
  PHONE_AUDIO_INPUT       recording endpoint name (ffmpeg backend)
  PHONE_AUDIO_OUTPUT      playback endpoint name (documentation only; MCI uses the default)
  PHONE_TTS_ENGINE        sapi | cmd | aval
  PHONE_TTS_VOICE         exact or partial SAPI voice name
  PHONE_TTS_CMD           local TTS command with {out} and {text_file}
  PHONE_STT_ENGINE        cmd | aval
  PHONE_STT_CMD           local STT command with {wav}, transcript on stdout
  AVAL_API_KEY            Aval.ai key (falls back to the avalai provider config)
  PHONE_AVAL_TTS_MODEL    e.g. eleven_flash_v2_5   (bench/voice measured set)
  PHONE_AVAL_TTS_VOICE    voice id for that model
  PHONE_AVAL_STT_MODEL    e.g. scribe_v2           (bench/voice measured set)
  PHONE_AVAL_BUDGET_USD   voice spend ceiling for one call (default 0.05)
  PHONE_SCRIPT            newline-separated scripted caller lines (simulation)

Exit codes: 0 ok, 1 error, 2 blocked (approval, allowlist or call cap).
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function print(value, asJson) {
  if (asJson || typeof value !== "object" || value === null) {
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function icon(ok) {
  return ok ? "OK  " : "FAIL";
}

function printReadiness(report) {
  console.log(`mode            : ${report.mode}${report.mode === "live" ? "" : " (real dialing still needs approval)"}`);
  console.log(`ready to dial   : ${report.readyToDial ? "yes" : "no"}`);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  // Say *why* talking is not ready: "speech-to-text missing" was wrong whenever the
  // real blocker was the phone or the audio route, and a misleading reason is worse
  // than no reason when an operator is following this list.
  const talkBlockers = [
    !byId.device?.ok && "no authorised Android device",
    !byId.audio?.ok && "no audio route",
    !byId.tts?.ok && "no Persian-capable TTS",
    byId.stt && !byId.stt.ok && "no speech-to-text engine",
  ].filter(Boolean);
  console.log(`ready to talk   : ${report.readyToTalk ? "yes" : `no (${talkBlockers.join("; ") || "see checks"})`}`);
  console.log("checks:");
  for (const check of report.checks) {
    const state = check.skipped ? "SKIP" : icon(check.ok);
    console.log(`  ${state}  ${check.id.padEnd(9)} ${check.detail}`);
    if (!check.ok && !check.skipped && check.hint && check.hint !== check.detail) console.log(`         → ${check.hint}`);
  }
  if (report.nextSteps.length) {
    console.log("\nnext steps:");
    for (const step of report.nextSteps) console.log(`  - ${step}`);
  }
}

function printCall(result) {
  if (!result.ok) {
    console.log(`call failed: ${result.error}`);
    if (result.hint) console.log(`hint: ${result.hint}`);
    return;
  }
  console.log(`call ${result.code}  id=${result.id || "-"}  to=${result.to.national} (${result.to.kind})`);
  if (result.greeting) {
    console.log(result.greeting.ok ? `greeting: spoken (${result.greeting.chars} chars, ${result.greeting.voice || "simulated"})` : `greeting failed: ${result.greeting.error}`);
    if (result.greeting.warning) console.log(`warning: ${result.greeting.warning}`);
  }
  if (result.hint) console.log(`hint: ${result.hint}`);
}

function printListen(result) {
  if (!result.ok) {
    console.log(`listen failed: ${result.error}`);
    if (result.hint) console.log(`hint: ${result.hint}`);
    return;
  }
  if (result.text) {
    console.log(`caller: ${result.text}`);
  } else {
    console.log(`caller: (nothing transcribed${result.hasSpeech === false ? "; recording was silent" : ""})`);
  }
  if (result.stt && result.stt.ok === false) console.log(`stt: ${result.stt.code || "unavailable"}${result.stt.hint ? ` — ${result.stt.hint}` : ""}`);
  if (result.hint) console.log(`hint: ${result.hint}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "readiness";
  const asJson = Boolean(args.json);
  const config = loadConfig();

  if (command === "help" || args.help) {
    print(HELP, false);
    return 0;
  }

  if (command === "readiness") {
    const report = await readiness({ config });
    if (asJson) print(report, true);
    else printReadiness(report);
    return report.ok || report.mode === "simulate" ? 0 : 1;
  }

  if (command === "devices") {
    const [device, info] = await Promise.all([deviceStatus(config), telemetry(config)]);
    const report = { adbPath: config.adb.path, ...device, telemetry: info };
    if (asJson) return print(report, true), 0;
    console.log(`adb: ${config.adb.path}`);
    console.log(`state: ${device.state}${device.hint ? ` — ${device.hint}` : ""}`);
    for (const entry of device.devices) console.log(`  - ${entry.serial}  ${entry.state}  ${entry.model}`);
    if (info.ok) console.log(`phone: ${info.model}  battery ${info.battery ?? "?"}%  carrier ${info.operator || "?"}`);
    return device.ok ? 0 : 1;
  }

  if (command === "audio") {
    const report = await audioEndpoints({ config });
    if (asJson) return print(report, true), 0;
    console.log(`backend: ${report.backend}`);
    console.log(`configured input : ${report.configuredInput || "(Windows default)"}`);
    console.log(`configured output: ${report.configuredOutput || "(Windows default)"}`);
    for (const endpoint of report.endpoints) {
      console.log(`  - ${endpoint.name}${endpoint.likelyPhoneBridge ? "   [looks like a phone link]" : ""}`);
    }
    if (report.hint) console.log(`hint: ${report.hint}`);
    return report.ok ? 0 : 1;
  }

  if (command === "voices") {
    const report = await voices({ config });
    if (asJson) return print(report, true), 0;
    if (!report.ok) {
      console.log(`voices unavailable: ${report.error}`);
      return 1;
    }
    console.log(`selected: ${report.selected || "(system default)"}${report.configured ? ` — configured "${report.configured}"` : ""}`);
    for (const voice of report.voices) console.log(`  - ${voice.name}  (${voice.culture}, ${voice.gender})`);
    if (!report.hasPersian) console.log("hint: no Persian voice installed; Persian text will be mispronounced. See README → Persian voice.");
    return 0;
  }

  if (command === "voice") {
    const aval = config.aval || {};
    const report = {
      tts: { engine: config.tts.engine, model: config.tts.engine === "aval" ? aval.ttsModel || null : config.tts.engine === "cmd" ? config.tts.command.split(/\s+/)[0] : config.tts.voice || "system default", format: aval.ttsFormat, price: aval.ttsPricing || null },
      stt: { engine: config.stt.engine, model: config.stt.engine === "aval" ? aval.sttModel || null : config.stt.command ? config.stt.command.split(/\s+/)[0] : null, language: config.stt.language },
      key: aval.apiKey ? `present (${aval.apiKey.slice(0, 5)}…)` : "missing",
      baseUrl: aval.baseUrl,
      budgetUsdPerCall: aval.budgetUsdPerCall,
    };

    if (args.probe) {
      const phrase = String(args.text || "سلام، این یک آزمایش صدای فارسی است.");
      if (report.tts.engine !== "aval" || report.stt.engine !== "aval") {
        report.probe = { ok: false, error: "--probe checks the Aval voice path; set PHONE_TTS_ENGINE=aval and PHONE_STT_ENGINE=aval" };
      } else {
        const said = await avalSpeak(config, phrase);
        const step = { speak: said.ok ? { ok: true, ms: said.ms, seconds: said.duration, usd: said.usd, path: said.path } : { ok: false, code: said.code, error: said.error } };
        if (said.ok) {
          const back = await avalHear(config, said.path);
          step.transcribe = back.ok ? { ok: true, text: back.text, ms: back.ms, usd: back.usd, contains_greeting: back.text.includes("سلام") } : { ok: false, code: back.code, error: back.error };
          step.total_ms = (said.ms || 0) + (back.ms || 0);
          step.total_usd = Number((((said.usd || 0) + (back.usd || 0))).toFixed(6));
        }
        report.probe = step;
      }
    }

    if (asJson) return print(report, true), 0;
    console.log(`TTS  ${icon(report.tts.engine === "aval" ? Boolean(aval.apiKey && aval.ttsModel) : true)} ${report.tts.engine}${report.tts.model ? ` → ${report.tts.model}` : ""}${report.tts.format ? ` (${report.tts.format})` : ""}`);
    console.log(`STT  ${icon(report.stt.engine === "aval" ? Boolean(aval.apiKey && aval.sttModel) : true)} ${report.stt.engine}${report.stt.model ? ` → ${report.stt.model}` : ""} (lang ${report.stt.language})`);
    console.log(`key  ${report.key}  @ ${report.baseUrl}`);
    console.log(`cap  $${report.budgetUsdPerCall} voice spend per call`);
    if (report.probe) {
      const p = report.probe;
      if (!p.ok && !p.speak) console.log(`probe FAIL: ${p.error}`);
      else {
        console.log(`probe speak: ${p.speak.ok ? `${p.speak.seconds}s in ${p.speak.ms}ms ($${p.speak.usd})` : `FAIL ${p.speak.error}`}`);
        if (p.transcribe) console.log(`probe heard  : "${p.transcribe.text}" ${p.transcribe.contains_greeting ? "(Persian greeting recognised)" : "(greeting NOT recognised)"} in ${p.transcribe.ms}ms`);
        if (p.total_ms) console.log(`probe turn   : ${p.total_ms}ms total, $${p.total_usd}`);
      }
    }
    return report.probe && report.probe.transcribe ? (report.probe.transcribe.contains_greeting ? 0 : 1) : 0;
  }

  if (command === "normalize") {
    const result = normalizeIranNumber(args._[1] ?? args.number);
    print(result, asJson);
    return result.ok ? 0 : 1;
  }

  if (command === "log") {
    const records = readCallRecords(config, Number(args.limit) || 20);
    if (asJson) return print(records, true), 0;
    if (!records.length) return print("no calls recorded yet", false), 0;
    for (const record of records) {
      const when = record.at || "?";
      const who = record.to || "?";
      const what = record.event || "call";
      const state = record.ok ? "ok" : record.code || "failed";
      console.log(`${when}  ${what.padEnd(7)} ${who.padEnd(12)} ${state}${record.error ? `  ${record.error}` : ""}`);
    }
    return 0;
  }

  if (command === "call") {
    const result = await dial({
      to: args.to ?? args._[1],
      greeting: args.greeting ?? args.text,
      dryRun: Boolean(args["dry-run"]),
      simulate: Boolean(args.simulate),
      allowDial: Boolean(args["allow-dial"]),
      config,
    });
    if (asJson) print(result, true);
    else printCall(result);
    if (result.ok) return 0;
    return result.blocked ? 2 : 1;
  }

  if (command === "say") {
    const result = await say({ text: args.text ?? args._[1], config });
    if (asJson) print(result, true);
    else if (result.ok) console.log(`spoke ${result.chars} chars${result.simulated ? " (simulated)" : ` via ${result.voice}`}${result.warning ? `\nwarning: ${result.warning}` : ""}`);
    else console.log(`say failed: ${result.error}${result.hint ? `\nhint: ${result.hint}` : ""}`);
    return result.ok ? 0 : 1;
  }

  if (command === "listen") {
    const listenConfig = args["until-silence"] ? { ...config, listenUntilSilence: true } : config;
    const result = await listen({ seconds: Number(args.seconds) || undefined, config: listenConfig });
    if (asJson) print(result, true);
    else printListen(result);
    return result.ok ? 0 : 1;
  }

  if (command === "hangup") {
    const result = await hangup({ config });
    if (asJson) print(result, true);
    else if (result.ok) console.log(`hung up${result.turns ? ` after ${result.turns} turn(s)` : ""}${result.archive ? `\narchive: ${result.archive}` : ""}`);
    else console.log(`hangup failed: ${result.error}`);
    return result.ok ? 0 : 1;
  }

  if (command === "status") {
    const result = await status({ config });
    if (asJson) print(result, true);
    else {
      console.log(`state: ${result.state}${result.code ? ` (${result.code})` : ""}`);
      if (result.session) {
        console.log(`call : ${result.session.id}  to ${result.session.to.national}  ${result.session.durationSeconds}s  ${result.session.turns} turn(s)`);
        if (result.transcript) console.log(`\n${result.transcript}`);
      } else console.log("call : none");
      if (result.hint) console.log(`hint: ${result.hint}`);
    }
    return 0;
  }

  if (command === "selftest") {
    const result = await selftest({ seconds: Number(args.seconds) || undefined, config });
    if (asJson) print(result, true);
    else {
      for (const step of result.steps) {
        console.log(`${icon(step.ok)}  ${step.step.padEnd(7)} ${step.detail}`);
        if (step.warning) console.log(`        warning: ${step.warning}`);
        if (!step.ok && step.hint) console.log(`        → ${step.hint}`);
      }
      if (result.hint) console.log(`hint: ${result.hint}`);
    }
    return result.ok ? 0 : 1;
  }

  print(`unknown command "${command}"\n\n${HELP}`, false);
  return 1;
}

main()
  .then((code) => process.exit(Number(code) || 0))
  .catch((error) => {
    console.error(`phone-bridge error: ${error?.message || error}`);
    process.exit(1);
  });

export { parseArgs };
