// Audio media plane.
//
// Control goes over ADB, but the voice has to travel between the PC and the
// phone. Three wiring options are supported, exactly like SIMVox-AI:
//
//   1. Bluetooth HFP  — pair the phone to the PC; Windows exposes the phone as
//                       "Headset Earphone"/"Headset Microphone" during a call.
//   2. TRRS splitter  — 4-pole 3.5 mm cable into a USB sound card.
//   3. Virtual cable  — VB-CABLE/VoiceMeeter loopback.
//
// In all three cases Windows presents the phone link as an ordinary recording
// and playback endpoint. By default this module uses the *Windows default*
// devices (MCI), which is why the docs say "set the phone bridge as default".
// When ffmpeg is installed it can capture from a named DirectShow device
// instead, which avoids changing the system default.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WINDOWS } from "../config.mjs";
import { runProcess } from "./adb.mjs";
import { runTemplate } from "./shell.mjs";
import { convertWavFile, probeWav, rms as wavRms, wavDuration } from "./wav.mjs";
import { powershell, powershellJson, requireWindows } from "./win.mjs";

let ffmpegCache = null;

export async function ffmpegAvailable(config) {
  if (ffmpegCache !== null) return ffmpegCache;
  const result = await runProcess(config.audio.ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 5000 });
  ffmpegCache = Boolean(result.ok && /ffmpeg version/i.test(`${result.stdout}${result.stderr}`));
  return ffmpegCache;
}

export function resetFfmpegCache() {
  ffmpegCache = null;
}

/** Which capture path will be used: "ffmpeg", "mci" or "none". */
export async function audioBackend(config) {
  const requested = config.audio.backend;
  if (requested === "none") return "none";
  if (requested === "ffmpeg") return (await ffmpegAvailable(config)) ? "ffmpeg" : "none";
  if (requested === "mci") return IS_WINDOWS ? "mci" : "none";
  if (!IS_WINDOWS) return (await ffmpegAvailable(config)) ? "ffmpeg" : "none";
  // ffmpeg only wins when the operator named the capture device: the dshow path
  // needs `-i audio=<name>`, and a vendored binary alone must not break the MCI
  // capture that already works with the Windows default device.
  if (config.audio.inputDevice && (await ffmpegAvailable(config))) return "ffmpeg";
  return "mci";
}

function tempWav(label) {
  return path.join(os.tmpdir(), `phone-bridge-${label}-${process.pid}-${Date.now()}.wav`);
}

/** List Windows playback/recording endpoints, marking likely phone links. */
export async function listAudioEndpoints() {
  if (!IS_WINDOWS) return { ok: false, code: "unsupported-platform", endpoints: [], hint: "run on Windows, or configure PHONE_AUDIO_* and ffmpeg" };

  const script = `
$endpoints = @()
try {
  $endpoints = @(Get-PnpDevice -Class AudioEndpoint | Select-Object FriendlyName, Status)
} catch {
  $endpoints = @()
}
$devices = @(Get-CimInstance Win32_SoundDevice | Select-Object Name, Status)
@{ endpoints = $endpoints; adapters = $devices } | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $env:PHONE_PS_OUT -Encoding UTF8
`;
  const result = await powershellJson(script, { timeoutMs: 20000 });
  if (!result.ok) return { ok: false, error: result.error, endpoints: [], adapters: [] };

  const endpoints = (result.data?.endpoints ?? []).map((entry) => ({
    name: entry.FriendlyName || entry.Name || "unknown",
    status: entry.Status || null,
    likelyPhoneBridge: /cable|vb-audio|voicemeeter|hands-free|headset|bluetooth|usb audio|line in|stereo mix/i.test(
      String(entry.FriendlyName || ""),
    ),
  }));

  return {
    ok: true,
    endpoints,
    adapters: result.data?.adapters ?? [],
    hint: endpoints.some((entry) => entry.likelyPhoneBridge)
      ? null
      : "no endpoint looks like a phone bridge (no Bluetooth headset, VB-CABLE or USB audio device). See README → Audio routing.",
  };
}

/**
 * Record from the phone link.
 *
 * @returns {{ok:boolean, path?:string, duration?:number, hasSpeech?:boolean,
 *            rms?:number, backend?:string, error?:string, hint?:string}}
 */
export async function record(config, { seconds = 8, backend, timeoutMs } = {}) {
  const chosen = backend || (await audioBackend(config));
  const duration = Math.max(2, Math.min(config.maxListenSeconds, Number(seconds) || config.listenSeconds));
  const raw = tempWav("rec");
  const clean = tempWav("rec16k");

  try {
    if (chosen === "none") {
      return {
        ok: false,
        code: "audio-unavailable",
        error: IS_WINDOWS ? "no audio backend: install ffmpeg or leave PHONE_AUDIO_BACKEND=auto" : "no audio backend on this platform",
        hint: "install ffmpeg (winget install Gyan.FFmpeg) for explicit device selection, or use PHONE_AUDIO_BACKEND=mci on Windows",
      };
    }

    if (chosen === "ffmpeg") {
      if (!config.audio.inputDevice) {
        return {
          ok: false,
          code: "audio-input-missing",
          error: "the ffmpeg backend records from a named device, but PHONE_AUDIO_INPUT is empty",
          hint: 'set PHONE_AUDIO_INPUT to the recording endpoint, e.g. "CABLE Output (VB-Audio Virtual Cable)" or "Headset Microphone (Bluetooth Hands-Free Audio)"; run `node src/cli.mjs audio` to list names',
        };
      }
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "dshow",
        "-i",
        `audio=${config.audio.inputDevice}`,
        "-t",
        String(duration),
        "-ac",
        "1",
        "-ar",
        String(config.audio.sampleRate),
        "-c:a",
        "pcm_s16le",
        clean,
      ];
      const result = await runProcess(config.audio.ffmpeg, args, { timeoutMs: timeoutMs || (duration + 15) * 1000 });
      if (!result.ok || !fs.existsSync(clean)) {
        return {
          ok: false,
          code: "audio-capture-failed",
          error: (result.stderr || result.stdout || "ffmpeg produced no audio").trim().slice(0, 600),
          hint: "check the exact device name with `node src/cli.mjs audio`, and make sure the phone link is the active recording device",
        };
      }
    } else {
      // MCI always uses the Windows default recording device.
      const script = `
Add-Type -Name W -Namespace M -MemberDefinition '[DllImport("winmm.dll", CharSet=CharSet.Auto)] public static extern int mciSendString(string c, System.Text.StringBuilder r, int l, System.IntPtr h);'
$ErrorActionPreference = 'Stop'
$r = New-Object System.Text.StringBuilder 512
$out = $env:PHONE_MCI_OUT
$rc = [M.W]::mciSendString("open new type waveaudio alias phonecap", $r, 512, [IntPtr]::Zero)
if ($rc -ne 0) { Write-Error "mci open failed ($rc)"; exit 3 }
[void][M.W]::mciSendString("record phonecap", $r, 512, [IntPtr]::Zero)
Start-Sleep -Milliseconds $env:PHONE_MCI_MS
[void][M.W]::mciSendString("stop phonecap", $r, 512, [IntPtr]::Zero)
$rc = [M.W]::mciSendString("save phonecap $([char]34)$out$([char]34)", $r, 512, [IntPtr]::Zero)
[void][M.W]::mciSendString("close phonecap", $r, 512, [IntPtr]::Zero)
if ($rc -ne 0) { Write-Error "mci save failed ($rc)"; exit 4 }
`;
      const result = await powershell(script, {
        timeoutMs: timeoutMs || (duration + 15) * 1000,
        env: { ...process.env, PHONE_MCI_OUT: raw, PHONE_MCI_MS: String(duration * 1000) },
      });
      if (!result.ok || !fs.existsSync(raw)) {
        return {
          ok: false,
          code: "audio-capture-failed",
          error: (result.stderr || result.stdout || "MCI recording failed").trim().slice(0, 600),
          hint: "Windows may be blocking microphone access: Settings → Privacy → Microphone → allow desktop apps",
        };
      }
      // Normalize 8/11 kHz 8-bit mapper output into 16 kHz 16-bit PCM.
      const converted = convertWavFile(raw, clean, { sampleRate: config.audio.sampleRate });
      return finishRecord(clean, converted.duration, "mci", config, {
        warning:
          "recorded through the Windows default input (MCI); it cannot select a device, so the phone link must be the default recording device",
      });
    }

    return finishRecord(clean, wavDuration(clean), "ffmpeg", config);
  } catch (error) {
    return { ok: false, code: "audio-error", error: String(error?.message || error) };
  } finally {
    try {
      if (fs.existsSync(raw)) fs.unlinkSync(raw);
    } catch {
      // best effort
    }
  }
}

function finishRecord(file, duration, backend, config, extra = {}) {
  const energy = wavRms(file);
  return {
    ok: true,
    path: file,
    duration,
    backend,
    rms: energy,
    hasSpeech: energy >= config.audio.minRms,
    ...extra,
    hint:
      energy < config.audio.minRms
        ? "the recording is silent: the phone's call audio is not reaching this PC input (wrong default device, muted call, or Bluetooth HFP not in use)"
        : null,
  };
}

/** Play a WAV to the phone link. */
export async function play(config, wavPath, { timeoutMs } = {}) {
  if (!fs.existsSync(wavPath)) return { ok: false, code: "missing-file", error: `audio file not found: ${wavPath}` };

  const probe = probeWav(wavPath);
  if (probe.ok && probe.silent) {
    return {
      ok: false,
      code: "empty-audio",
      duration: 0,
      error: "refusing to play an empty WAV: it contains no samples, so the call would hear silence",
    };
  }
  const duration = probe.duration;

  // Explicit hook wins, so any local player can be used.
  if (config.audio.playCmd) {
    const command = config.audio.playCmd.replace(/\{wav\}/g, wavPath);
    const result = await runTemplate(command, { timeoutMs: timeoutMs || (duration + 15) * 1000 });
    return { ok: result.ok, backend: "custom", duration, error: result.ok ? null : (result.stderr || result.stdout).trim().slice(0, 400) };
  }

  const blocked = requireWindows("Windows audio playback");
  if (blocked) return { ...blocked, duration };

  // MCI plays to the Windows default output and blocks until the file ends.
  const script = `
Add-Type -Name W -Namespace M -MemberDefinition '[DllImport("winmm.dll", CharSet=CharSet.Auto)] public static extern int mciSendString(string c, System.Text.StringBuilder r, int l, System.IntPtr h);'
$ErrorActionPreference = 'Stop'
$r = New-Object System.Text.StringBuilder 512
$file = $env:PHONE_MCI_OUT
$q = [char]34
$rc = [M.W]::mciSendString("open $q$file$q type waveaudio alias phonepb", $r, 512, [IntPtr]::Zero)
if ($rc -ne 0) { Write-Error "mci open failed ($rc)"; exit 3 }
$rc = [M.W]::mciSendString("play phonepb wait", $r, 512, [IntPtr]::Zero)
[void][M.W]::mciSendString("close phonepb", $r, 512, [IntPtr]::Zero)
if ($rc -ne 0) { Write-Error "mci play failed ($rc)"; exit 4 }
`;
  let result = await powershell(script, {
    timeoutMs: timeoutMs || (duration + 20) * 1000,
    env: { ...process.env, PHONE_MCI_OUT: wavPath },
  });

  if (result.ok) return { ok: true, backend: "mci", duration };

  // Fall back to SoundPlayer if MCI refused the file (e.g. unusual encoding).
  const fallback = await powershell(
    `(New-Object System.Media.SoundPlayer $env:PHONE_MCI_OUT).PlaySync()`,
    { timeoutMs: timeoutMs || (duration + 20) * 1000, env: { ...process.env, PHONE_MCI_OUT: wavPath } },
  );
  return {
    ok: fallback.ok,
    backend: "soundplayer",
    duration,
    error: fallback.ok ? null : (fallback.stderr || fallback.stdout || result.stderr || "playback failed").trim().slice(0, 400),
  };
}
