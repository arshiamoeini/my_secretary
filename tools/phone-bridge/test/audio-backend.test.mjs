// Capture-backend selection.
//
// The vendored ffmpeg (bench/voice put it in vendor/ffmpeg) makes an
// `-i audio=<device>` capture possible, which is what the phone route needs. But
// the dshow input must be named: choosing ffmpeg just because a binary exists
// would break the MCI capture that already works with the Windows default
// device. So: ffmpeg only when PHONE_AUDIO_INPUT is set (or explicitly demanded).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { audioBackend, ffmpegAvailable, resetFfmpegCache } from "../src/local/audio.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audio-backend-"));

function configWith(overrides) {
  const config = loadConfig({ PHONE_AUDIT_DIR: tmp, ...overrides });
  if (!overrides.PHONE_AUDIO_BACKEND) config.audio.backend = "auto";
  return config;
}

test("a missing binary leaves Windows on MCI", async () => {
  resetFfmpegCache();
  const config = configWith({});
  config.audio.ffmpeg = path.join(tmp, "no-such-ffmpeg.exe");
  assert.equal(await ffmpegAvailable(config), false);
  assert.equal(await audioBackend(config), "mci");
});

test("an unnamed capture device does not switch to ffmpeg", async () => {
  const ffmpeg = path.join(ROOT_DIR, "vendor", "ffmpeg", "ffmpeg.exe");
  if (!fs.existsSync(ffmpeg)) {
    console.log("  - skipped: no vendored ffmpeg (run bench/voice/corpus.mjs setup)");
    return;
  }
  resetFfmpegCache();
  const config = configWith({});
  config.audio.ffmpeg = ffmpeg;
  config.audio.inputDevice = "";
  assert.equal(await ffmpegAvailable(config), true);
  assert.equal(await audioBackend(config), "mci", "MCI still records from the default device");

  config.audio.inputDevice = "Headset Microphone (Bluetooth Hands-Free Audio)";
  assert.equal(await audioBackend(config), "ffmpeg", "a named phone link is exactly what dshow is for");

  resetFfmpegCache();
});

test("an explicit backend is honoured", async () => {
  resetFfmpegCache();
  const forced = configWith({ PHONE_AUDIO_BACKEND: "mci" });
  forced.audio.ffmpeg = path.join(ROOT_DIR, "vendor", "ffmpeg", "ffmpeg.exe");
  forced.audio.inputDevice = "whatever";
  assert.equal(await audioBackend(forced), "mci");

  const off = configWith({ PHONE_AUDIO_BACKEND: "none" });
  assert.equal(await audioBackend(off), "none");
  resetFfmpegCache();
});
