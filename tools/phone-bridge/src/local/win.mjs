// Small helper for Windows-native audio and speech APIs.
//
// Everything here uses only what ships with Windows (PowerShell + .NET +
// winmm), so the bridge has no npm dependencies and no cloud calls.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runProcess } from "./adb.mjs";
import { IS_WINDOWS } from "../config.mjs";

export const POWERSHELL = "powershell.exe";

export function powershell(script, { timeoutMs = 30000, env = process.env } = {}) {
  return runProcess(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs, env },
  );
}

/**
 * Run a PowerShell snippet that writes UTF-8 JSON to a temp file.
 * A file is used instead of stdout because Windows PowerShell mixes warnings
 * and progress output into the stream.
 */
export async function powershellJson(script, { timeoutMs = 30000, env = process.env } = {}) {
  const out = path.join(os.tmpdir(), `phone-bridge-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const wrapped = `$ErrorActionPreference = 'SilentlyContinue'\n$env:PHONE_PS_OUT = '${out.replace(/'/g, "''")}'\n${script}\n`;
  const result = await powershell(wrapped, { timeoutMs, env });
  try {
    if (!fs.existsSync(out)) return { ok: false, error: (result.stderr || result.stdout || "PowerShell produced no output").trim(), result };
    const text = fs.readFileSync(out, "utf8").replace(/^\uFEFF/, "").trim();
    return { ok: true, data: text ? JSON.parse(text) : null, result };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), result };
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      // best effort
    }
  }
}

export function requireWindows(feature) {
  if (IS_WINDOWS) return null;
  return {
    ok: false,
    code: "unsupported-platform",
    error: `${feature} uses Windows-native APIs; on this platform configure PHONE_TTS_CMD / PHONE_STT_CMD / PHONE_PLAY_CMD instead`,
  };
}
