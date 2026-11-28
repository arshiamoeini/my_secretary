// Text-to-speech, entirely local.
//
// Default engine is Windows SAPI (`System.Speech`), which needs no install and
// no network. Persian quality depends on a Persian voice being installed:
// Windows Settings → Time & language → Language & region → Persian →
// Language options → Speech. If no fa-IR voice exists, the bridge still speaks
// — with the default English voice — and returns an explicit warning instead of
// pretending the pronunciation is correct.
//
// SAPI also has a harsher failure mode: an en-US voice asked to speak pure
// Persian script writes a valid but empty WAV (46-byte header, no samples) and
// reports success. `synthesize` treats that as an error, because "played
// silence into a live call" is worse than a clear failure.
//
// Any other local engine can be plugged in through PHONE_TTS_CMD, for example
// Piper with a Persian model or eSpeak-NG.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTemplate } from "./shell.mjs";
import { probeWav } from "./wav.mjs";
import { powershell, powershellJson, requireWindows } from "./win.mjs";

const PERSIAN = /[\u0600-\u06FF]/;

export function looksPersian(text) {
  return PERSIAN.test(String(text ?? ""));
}

export function cleanText(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export async function listVoices() {
  const blocked = requireWindows("Windows SAPI voices");
  if (blocked) return { ...blocked, voices: [], hasPersian: false };

  const script = `
Add-Type -AssemblyName System.Speech
$list = @()
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
foreach ($v in $synth.GetInstalledVoices()) {
  if ($v.Enabled) {
    $list += [pscustomobject]@{ name = $v.VoiceInfo.Name; culture = $v.VoiceInfo.Culture.Name; gender = [string]$v.VoiceInfo.Gender }
  }
}
$synth.Dispose()
@{ voices = $list } | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $env:PHONE_PS_OUT -Encoding UTF8
`;
  const result = await powershellJson(script, { timeoutMs: 30000 });
  if (!result.ok) return { ok: false, error: result.error, voices: [], hasPersian: false };

  const voices = (result.data?.voices ?? []).map((voice) => ({
    name: voice.name,
    culture: voice.culture || "",
    gender: voice.gender || "",
  }));
  const hasPersian = voices.some((voice) => /^fa(-|$)/i.test(voice.culture));
  return { ok: true, voices, hasPersian };
}

/** Resolve the configured voice name against what is actually installed. */
export function pickVoice(configured, voices) {
  const wanted = String(configured ?? "").trim();
  if (!wanted) {
    return (
      voices.find((voice) => /^fa(-|$)/i.test(voice.culture)) ||
      voices.find((voice) => /dilara/i.test(voice.name)) ||
      voices[0] ||
      null
    );
  }
  const lower = wanted.toLowerCase();
  return (
    voices.find((voice) => voice.name.toLowerCase() === lower) ||
    voices.find((voice) => voice.culture.toLowerCase() === lower) ||
    voices.find((voice) => voice.name.toLowerCase().includes(lower)) ||
    voices.find((voice) => voice.culture.toLowerCase().startsWith(lower)) ||
    null
  );
}

function tempPath(label, ext) {
  return path.join(os.tmpdir(), `phone-bridge-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
}

function quiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // best effort
  }
}

/**
 * Synthesize `text` to a WAV file.
 *
 * @returns {{ok:boolean, path?:string, engine?:string, voice?:string, culture?:string,
 *            warning?:string|null, error?:string, hint?:string}}
 */
export async function synthesize(config, text, { out } = {}) {
  const spoken = cleanText(text);
  if (!spoken) return { ok: false, code: "empty-text", error: "nothing to say: text is empty" };
  if (spoken.length > config.maxText) {
    return { ok: false, code: "text-too-long", error: `text too long (${spoken.length} > ${config.maxText}); split it into sentences` };
  }

  const target = out || tempPath("tts", "wav");
  const persian = looksPersian(spoken);
  const warnings = [];

  try {
    if (config.tts.engine === "aval") {
      // Cloud Persian voice. Imported lazily so the local engines keep working
      // with no network and no key, and so there is no import cycle.
      const aval = await import("./aval.mjs");
      return aval.speak(config, spoken, { out: target });
    }

    if (config.tts.engine === "cmd") {
      if (!config.tts.command) {
        return { ok: false, code: "tts-not-configured", error: "PHONE_TTS_ENGINE=cmd requires PHONE_TTS_CMD" };
      }
      const textFile = tempPath("tts-text", "txt");
      fs.writeFileSync(textFile, spoken, "utf8");
      const command = config.tts.command
        .replace(/\{out\}/g, target)
        .replace(/\{text_file\}/g, textFile)
        .replace(/\{text\}/g, spoken);
      const result = await runTemplate(command, {
        timeoutMs: 120000,
        env: { ...process.env, PHONE_TTS_TEXT: spoken, PHONE_TTS_OUT: target, PHONE_TTS_TEXT_FILE: textFile },
      });
      try {
        fs.unlinkSync(textFile);
      } catch {
        // best effort
      }
      if (!result.ok || !fs.existsSync(target)) {
        return {
          ok: false,
          code: "tts-failed",
          error: (result.stderr || result.stdout || "TTS command produced no file").trim().slice(0, 500),
        };
      }
      const studied = probeWav(target);
      if (studied.silent) {
        quiet(target);
        return {
          ok: false,
          code: "tts-silent-output",
          error: `the TTS command wrote no audio for ${spoken.length} character(s) of text (${studied.error || "empty WAV"})`,
          hint: "check that PHONE_TTS_CMD writes a WAV to {out} and that the model supports the text language",
        };
      }
      return { ok: true, path: target, engine: "cmd", voice: "custom", culture: "", warning: null, duration: studied.duration };
    }

    const blocked = requireWindows("Windows SAPI text-to-speech");
    if (blocked) return blocked;

    const installed = await listVoices();
    if (!installed.ok) return { ok: false, code: "tts-unavailable", error: installed.error };
    const voice = pickVoice(config.tts.voice, installed.voices);
    if (config.tts.voice && !voice) {
      return {
        ok: false,
        code: "voice-not-found",
        error: `PHONE_TTS_VOICE="${config.tts.voice}" does not match an installed voice`,
        available: installed.voices.map((entry) => `${entry.name} (${entry.culture})`),
        hint: installed.hasPersian ? null : "no Persian voice is installed; see README → Persian voice",
      };
    }
    const voiceName = voice?.name || "";
    const culture = voice?.culture || "";

    if (persian && !/^fa(-|$)/i.test(culture)) {
      warnings.push(
        culture
          ? `the selected voice is ${culture}; Persian text will be mispronounced. Install a Persian Windows voice or set PHONE_TTS_CMD.`
          : "no Windows voice is installed; Persian text will not be spoken correctly.",
      );
    }

    const textFile = tempPath("tts-text", "txt");
    fs.writeFileSync(textFile, spoken, "utf8");
    const script = `
Add-Type -AssemblyName System.Speech
$ErrorActionPreference = 'Stop'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $env:PHONE_TTS_VOICE
if ($voice) {
  try { $synth.SelectVoice($voice) } catch { Write-Error "cannot select voice: $voice"; exit 3 }
}
$synth.Rate = [int]$env:PHONE_TTS_RATE
$text = [IO.File]::ReadAllText($env:PHONE_TTS_TEXT_FILE, [Text.Encoding]::UTF8)
$synth.SetOutputToWaveFile($env:PHONE_TTS_OUT)
$synth.Speak($text)
$synth.Dispose()
`;
    const result = await powershell(script, {
      timeoutMs: 120000,
      env: {
        ...process.env,
        PHONE_TTS_VOICE: voiceName,
        PHONE_TTS_RATE: String(Math.max(-10, Math.min(10, Number(config.tts.rate) || 0))),
        PHONE_TTS_TEXT_FILE: textFile,
        PHONE_TTS_OUT: target,
      },
    });
    try {
      fs.unlinkSync(textFile);
    } catch {
      // best effort
    }

    if (!result.ok || !fs.existsSync(target)) {
      return {
        ok: false,
        code: "tts-failed",
        error: (result.stderr || result.stdout || "SAPI produced no audio").trim().slice(0, 500),
      };
    }

    const studied = probeWav(target);
    if (studied.silent) {
      quiet(target);
      return {
        ok: false,
        code: "tts-silent-output",
        error: persian
          ? `the installed Windows voice (${voiceName || "system default"}, ${culture || "unknown culture"}) wrote no audio for ${spoken.length} characters of Persian text`
          : `the installed Windows voice (${voiceName || "system default"}, ${culture || "unknown culture"}) wrote no audio`,
        hint: persian
          ? "Windows speech voices only speak the scripts they ship with: install a Persian voice (Settings → Time & language → Language & region → Persian → Speech) or set PHONE_TTS_CMD to a local Persian engine such as Piper (fa_IR) or eSpeak-NG (espeak-ng -v fa)"
          : "try a different PHONE_TTS_VOICE, or set PHONE_TTS_CMD to another local engine",
      };
    }

    return {
      ok: true,
      path: target,
      engine: "sapi",
      voice: voiceName || "system default",
      culture,
      warning: warnings.length ? warnings.join(" ") : null,
      duration: studied.duration,
    };
  } catch (error) {
    return { ok: false, code: "tts-error", error: String(error?.message || error) };
  }
}
