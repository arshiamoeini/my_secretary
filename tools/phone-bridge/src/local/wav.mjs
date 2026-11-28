// Minimal WAV reader/writer.
//
// Windows MCI records at whatever the sound mapper prefers (often 11 kHz,
// 8-bit), which is poor input for speech recognition. This module decodes any
// common PCM layout, downmixes to mono, resamples to 16 kHz with linear
// interpolation and writes 16-bit PCM. Pure JavaScript, no native modules.

import fs from "node:fs";

function readChunks(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }

  let fmt = null;
  let data = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    const end = Math.min(body + size, buffer.length);
    const available = end - body;

    if (id === "fmt " && available >= 16) {
      let audioFormat = buffer.readUInt16LE(body);
      const channels = buffer.readUInt16LE(body + 2);
      const sampleRate = buffer.readUInt32LE(body + 4);
      const bitsPerSample = buffer.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE stores the real format in the sub-format GUID.
      if (audioFormat === 0xfffe && available >= 26) audioFormat = buffer.readUInt16LE(body + 24);
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      data = buffer.subarray(body, end);
    }

    offset = body + size + (size % 2);
  }

  if (!fmt) throw new Error("WAV has no fmt chunk");
  if (!data) throw new Error("WAV has no data chunk");
  return { fmt, data };
}

/** Decode a WAV buffer to mono float samples in [-1, 1]. */
export function decodeWav(buffer) {
  const { fmt, data } = readChunks(buffer);
  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
  if (!channels) throw new Error("WAV reports zero channels");
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  if (!bytesPerSample) throw new Error("WAV reports zero bit depth");
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(data.length / frameBytes);
  const samples = new Float32Array(frames);

  const readSample = (offset) => {
    if (audioFormat === 3 && bitsPerSample === 32) return data.readFloatLE(offset);
    if (audioFormat !== 1) throw new Error(`unsupported WAV encoding (format ${audioFormat}, ${bitsPerSample}-bit)`);
    if (bitsPerSample === 8) return (data[offset] - 128) / 128;
    if (bitsPerSample === 16) return data.readInt16LE(offset) / 32768;
    if (bitsPerSample === 24) {
      const value = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
      return (value & 0x800000 ? value | 0xff000000 : value) / 8388608;
    }
    if (bitsPerSample === 32) return data.readInt32LE(offset) / 2147483648;
    throw new Error(`unsupported WAV bit depth: ${bitsPerSample}`);
  };

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += readSample(frame * frameBytes + channel * bytesPerSample);
    }
    samples[frame] = sum / channels;
  }

  return { samples, sampleRate, channels, bitsPerSample, duration: frames / sampleRate };
}

/** Linear resampling. Plenty for speech at 8–48 kHz. */
export function resample(samples, fromRate, toRate) {
  if (!samples.length) return new Float32Array(0);
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i / ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = samples[Math.min(index, samples.length - 1)];
    const b = samples[Math.min(index + 1, samples.length - 1)];
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

export function encodeWav16(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

export function readWav(path) {
  return decodeWav(fs.readFileSync(path));
}

export function wavDuration(path) {
  try {
    return readWav(path).duration;
  } catch {
    return 0;
  }
}

/**
 * Duration plus an emptiness check, without throwing.
 *
 * Windows SAPI happily writes a 46-byte header (no samples) when the installed
 * voice cannot pronounce the text — for example Persian script with an en-US
 * voice. Callers must treat that as a failure, never as "spoken".
 */
export function probeWav(file) {
  try {
    const decoded = readWav(file);
    return {
      ok: true,
      duration: decoded.duration,
      silent: decoded.samples.length === 0 || decoded.duration <= 0.05,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
    };
  } catch (error) {
    return { ok: false, duration: 0, silent: true, error: String(error?.message || error) };
  }
}

export function rms(path) {
  try {
    const { samples } = readWav(path);
    if (!samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  } catch {
    return 0;
  }
}

/** Convert any readable WAV to mono 16-bit PCM at `sampleRate`. */
export function convertWavFile(inputPath, outputPath, { sampleRate = 16000 } = {}) {
  const decoded = readWav(inputPath);
  const mono = resample(decoded.samples, decoded.sampleRate, sampleRate);
  fs.writeFileSync(outputPath, encodeWav16(mono, sampleRate));
  return {
    ok: true,
    path: outputPath,
    duration: mono.length / sampleRate,
    sampleRate,
    source: { sampleRate: decoded.sampleRate, channels: decoded.channels, bitsPerSample: decoded.bitsPerSample },
  };
}

/**
 * Milliseconds of continuous silence at the END of a WAV, using short-frame
 * RMS against `threshold`. This is what end-of-turn detection stops on.
 */
export function trailingSilenceMs(file, { threshold = 0.004, frameMs = 100 } = {}) {
  let decoded;
  try {
    decoded = readWav(file);
  } catch {
    return 0;
  }
  const { samples, sampleRate } = decoded;
  if (!samples.length) return 0;
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  let silent = 0;
  for (let end = samples.length; end > 0; end -= frame) {
    const start = Math.max(0, end - frame);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    const value = Math.sqrt(sum / Math.max(1, end - start));
    if (value < threshold) silent += (end - start) / sampleRate;
    else break;
  }
  return Math.round(silent * 1000);
}

/**
 * Join normalized mono WAVs into one file (for chunked end-of-turn capture).
 * All inputs must already be at `sampleRate`; decode/encode keeps it pure JS.
 */
export function concatWavFiles(files, outputPath, { sampleRate = 16000 } = {}) {
  const parts = files.map((f) => readWav(f).samples);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const merged = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    merged.set(part, at);
    at += part.length;
  }
  fs.writeFileSync(outputPath, encodeWav16(merged, sampleRate));
  return { ok: true, path: outputPath, duration: total / sampleRate, parts: parts.length };
}
