// Audio plumbing for the voice benchmark: transcode, band-limit, measure.
//
// ffmpeg is vendored under tools/phone-bridge/vendor/ffmpeg (gitignored). It is
// used only for test-set preparation and format conversion — the phone call
// itself still goes through the phone's SIM.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

export function ffmpegOrNull(env = process.env) {
  const candidates = [
    env.FFMPEG_PATH,
    path.join(ROOT, "vendor", "ffmpeg", "ffmpeg.exe"),
    path.join(ROOT, "vendor", "ffmpeg", "bin", "ffmpeg.exe"),
    "ffmpeg",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "ffmpeg") return "ffmpeg";
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function run(bin, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stdout: out, stderr: err, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: out, stderr: err });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: out, stderr: String(error?.message || error) });
    });
  });
}

/** The band a telephone line actually carries: 8 kHz, 300–3400 Hz, G.711-ish. */
export function telephoneChain() {
  return "highpass=f=300,lowpass=f=3400";
}

export async function toWav(bin, input, output, { rate = 16000, channels = 1, filters = "" } = {}) {
  const args = ["-y", "-loglevel", "error", "-i", input, "-ac", String(channels), "-ar", String(rate)];
  if (filters) args.push("-af", filters);
  args.push(output);
  const res = await run(bin, args);
  if (!res.ok || !fs.existsSync(output)) throw new Error(res.stderr.slice(-300) || "transcode produced no file");
  return output;
}

/** PCM16 little-endian → WAV (for engines that return raw samples). */
export function pcmToWav(pcm, { rate = 24000, channels = 1, bits = 16 } = {}) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  const byteRate = (rate * channels * bits) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function rms(file) {
  const b = fs.readFileSync(file);
  let sum = 0;
  let n = 0;
  for (let i = 44; i + 1 < b.length; i += 2) {
    const v = b.readInt16LE(i) / 32768;
    sum += v * v;
    n += 1;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * Headerless PCM has no sample rate, and getting it wrong makes the caller hear
 * a slowed-down voice. The rate is therefore inferred, not assumed: the same
 * sentence is also fetched as mp3 (which carries its own duration), and the
 * candidate rate whose byte-length implies that duration wins.
 */
export function detectPcmRate(pcmBytes, knownSeconds, rates = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000]) {
  if (!knownSeconds || knownSeconds <= 0) return null;
  let best = null;
  for (const rate of rates) {
    const implied = pcmBytes / (2 * rate);
    const error = Math.abs(implied - knownSeconds) / knownSeconds;
    if (!best || error < best.error) best = { rate, error: Number(error.toFixed(3)), implied: Number(implied.toFixed(2)) };
  }
  return best && best.error <= 0.3 ? best : null;
}

export async function probe(bin, file) {
  const res = await run(bin, ["-i", file, "-f", "null", "-"]);
  const m = /Duration:\s(\d+):(\d+):(\d+\.\d+)/.exec(res.stderr || "");
  return {
    ok: res.ok,
    seconds: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN,
    stderr: (res.stderr || "").slice(-400),
  };
}
