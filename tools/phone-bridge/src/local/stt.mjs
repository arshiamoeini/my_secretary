// Speech-to-text, entirely local.
//
// The bridge does not bundle a speech model (they are 50–500 MB). Instead it
// runs whatever local engine the operator installed through PHONE_STT_CMD and
// reads the transcript from stdout. Recommended: whisper.cpp with a
// multilingual model, which handles Persian:
//
//   PHONE_STT_CMD=C:\tools\whisper\whisper-cli.exe -m C:\tools\whisper\ggml-base.bin -l fa -nt -f "{wav}"
//
// If no engine is configured, `listen` still records audio and reports
// `stt: "not-configured"` so the operator knows the call can be heard but not
// understood. The agent then receives an honest empty transcript, never an
// invented one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./adb.mjs";
import { runTemplate } from "./shell.mjs";

const NOISE = /^\s*(\[?(blank_audio|silence|music|applause|inaudible)\]?|\.+)\s*$/i;

export function sttStatus(config) {
  if (config.stt.engine === "aval") {
    const aval = config.aval || {};
    if (!aval.apiKey) {
      return { ok: false, configured: false, code: "aval-key-missing", engine: "aval", hint: "set AVAL_API_KEY to use the Aval.ai Persian transcription models" };
    }
    if (!aval.sttModel) {
      return { ok: false, configured: false, code: "stt-not-configured", engine: "aval", hint: "PHONE_STT_ENGINE=aval needs PHONE_AVAL_STT_MODEL, e.g. gpt-4o-mini-transcribe" };
    }
    return { ok: true, configured: true, engine: `aval:${aval.sttModel}` };
  }
  if (!config.stt.command) {
    return {
      ok: false,
      configured: false,
      code: "stt-not-configured",
      hint: 'set PHONE_STT_CMD to a local engine, e.g. whisper-cli.exe -m models\\ggml-base.bin -l fa -nt -f "{wav}"',
    };
  }
  return { ok: true, configured: true, engine: config.stt.command.split(/\s+/)[0] };
}

/** Remove timestamps and engine chatter, keep the words. */
export function cleanTranscript(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*[^\]]*\]\s*/, "").trim())
    .filter((line) => line && !NOISE.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Transcribe a WAV file with the configured local engine.
 *
 * @returns {{ok:boolean, text:string, code?:string, error?:string, hint?:string}}
 */
export async function transcribe(config, wavPath) {
  if (config.stt.engine === "aval") {
    const aval = await import("./aval.mjs");
    return aval.hear(config, wavPath);
  }
  const status = sttStatus(config);
  if (!status.ok) {
    return {
      ok: false,
      text: "",
      code: status.code,
      error: "no local speech-to-text engine configured",
      hint: status.hint,
    };
  }
  if (!wavPath || !fs.existsSync(wavPath)) {
    return { ok: false, text: "", code: "missing-audio", error: `audio file not found: ${wavPath}` };
  }

  const outFile = path.join(os.tmpdir(), `phone-bridge-stt-${process.pid}-${Date.now()}.txt`);
  const command = config.stt.command
    .replace(/\{wav\}/g, wavPath)
    .replace(/\{language\}/g, config.stt.language)
    .replace(/\{out\}/g, outFile);
  const usesOutFile = config.stt.command.includes("{out}");

  try {
    const result = await runTemplate(command, {
      timeoutMs: config.stt.timeoutMs,
      env: { ...process.env, PHONE_STT_LANGUAGE: config.stt.language, PHONE_STT_WAV: wavPath, PHONE_STT_OUT: outFile },
    });

    let raw = result.stdout;
    if (usesOutFile && fs.existsSync(outFile)) raw = `${raw}\n${fs.readFileSync(outFile, "utf8")}`;

    if (!result.ok) {
      return {
        ok: false,
        text: cleanTranscript(raw),
        code: result.timedOut ? "stt-timeout" : "stt-failed",
        error: (result.stderr || result.stdout || "speech-to-text command failed").trim().slice(0, 600),
      };
    }

    const text = cleanTranscript(raw);
    return { ok: true, text, empty: !text };
  } catch (error) {
    return { ok: false, text: "", code: "stt-error", error: String(error?.message || error) };
  } finally {
    try {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    } catch {
      // best effort
    }
  }
}
