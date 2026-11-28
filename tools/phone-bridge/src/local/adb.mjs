// ADB control plane: the phone's own dialer places the call.
//
// This mirrors the approach used by SIMVox-AI: `adb shell am start` for outbound
// calls, `input keyevent` as the fallback for answer/hangup, and
// `dumpsys telephony.registry` to observe the call state. No telephony API, no
// SIP trunk, no per-minute fee — just the SIM in the phone.
//
// Every function returns data instead of throwing, because the agent loop must
// be able to read the failure and decide what to do next.

import { spawn } from "node:child_process";

const CALL_STATE_NAMES = { 0: "IDLE", 1: "RINGING", 2: "IN_CALL" };
const GLOBAL_ADB_COMMANDS = new Set(["connect", "disconnect", "pair", "devices", "kill-server", "start-server", "version"]);

/** Run a process without a shell and collect its output. */
export function runProcess(file, args, { timeoutMs = 15000, env = process.env, input } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, env });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout, stderr: String(error?.message || error), spawnError: true });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve({ ok: false, code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr || String(error?.message || error), spawnError: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });

    if (input) {
      try {
        child.stdin.end(input);
      } catch {
        // process may have exited already
      }
    }
  });
}

/** Parse `adb devices -l` into plain objects. */
export function parseDevices(output) {
  const devices = [];
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of") || line.startsWith("*") || line.startsWith("adb ")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state] = parts;
    if (!/^(device|unauthorized|offline|recovery|sideload|bootloader)$/.test(state)) continue;
    const meta = {};
    for (const part of parts.slice(2)) {
      const idx = part.indexOf(":");
      if (idx > 0) meta[part.slice(0, idx)] = part.slice(idx + 1);
    }
    const model = (meta.model || meta.device || "Unknown device").replace(/_/g, " ");
    devices.push({
      serial,
      state,
      model,
      product: meta.product || null,
      isEmulator: serial.startsWith("emulator-") || /sdk_gphone|vbox|goldfish/i.test(`${serial} ${model}`),
    });
  }
  return devices;
}

/** Extract the call state from `dumpsys telephony.registry | dumpsys telecom`. */
export function parseCallState(output) {
  const text = String(output ?? "");
  const registry = text.match(/mCallState\s*=\s*(\d)/);
  if (registry) return CALL_STATE_NAMES[registry[1]] || "UNKNOWN";
  if (/State:\s*(RINGING|INCOMING)/i.test(text)) return "RINGING";
  if (/State:\s*(ACTIVE|DIALING|CALL|HOLDING)/i.test(text)) return "IN_CALL";
  if (/mForegroundCallState\s*=\s*(\d)/.test(text)) {
    const match = text.match(/mForegroundCallState\s*=\s*(\d)/);
    const code = Number(match[1]);
    if (code === 1) return "RINGING";
    if (code >= 2) return "IN_CALL";
    return "IDLE";
  }
  return "UNKNOWN";
}

/** E.164 is the safest thing to hand to Android's CALL intent. */
export function telUri(number) {
  return `tel:${number.e164 || number.national}`;
}

export function buildDialArgs(config, number) {
  const serialArgs = config.adb.serial ? ["-s", config.adb.serial] : [];
  return [...serialArgs, "shell", "am", "start", "-a", "android.intent.action.CALL", "-d", telUri(number)];
}

export function buildCallStateArgs(config) {
  const serialArgs = config.adb.serial ? ["-s", config.adb.serial] : [];
  return [...serialArgs, "shell", "dumpsys", "telephony.registry"];
}

export function buildHangupArgs(config) {
  const serialArgs = config.adb.serial ? ["-s", config.adb.serial] : [];
  return [...serialArgs, "shell", "telecom", "end-call"];
}

export function buildAnswerArgs(config) {
  const serialArgs = config.adb.serial ? ["-s", config.adb.serial] : [];
  return [...serialArgs, "shell", "telecom", "accept-call"];
}

export function buildAdbArgs(config, command) {
  const words = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  const serialArgs = config.adb.serial && !GLOBAL_ADB_COMMANDS.has(words[0]) ? ["-s", config.adb.serial] : [];
  return [...serialArgs, ...words];
}

/** Run one adb command. Injected runner is used by tests. */
export async function runAdb(config, args, { timeoutMs = config.adb.timeoutMs, run = runProcess } = {}) {
  const result = await run(config.adb.path, args, { timeoutMs });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const denied = /no devices|device offline|device unauthorized|more than one device|not found/i.test(text);
  return {
    ok: Boolean(result.ok) && !denied,
    code: result.code,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    timedOut: Boolean(result.timedOut),
    spawnError: Boolean(result.spawnError),
  };
}

/**
 * Locate an authorized phone.
 *
 * @returns {{ok:boolean, state:"CONNECTED"|"UNAUTHORIZED"|"DISCONNECTED"|"NO_ADB",
 *            serial:string|null, model:string|null, devices:Array, hint:string|null}}
 */
export async function deviceStatus(config, { run = runProcess } = {}) {
  const version = await run(config.adb.path, ["version"], { timeoutMs: 5000 });
  if (!version.ok) {
    return {
      ok: false,
      state: "NO_ADB",
      serial: null,
      model: null,
      devices: [],
      hint: `adb not runnable at "${config.adb.path}": ${String(version.stderr || version.stdout || "not found").trim()}. Install Android platform-tools and put adb on PATH, or set ADB_PATH.`,
    };
  }

  const list = async () => {
    const result = await run(config.adb.path, ["devices", "-l"], { timeoutMs: config.adb.timeoutMs });
    return parseDevices(result.stdout);
  };

  let devices = await list();

  // Wireless debugging: attach once if nothing is plugged in.
  if (!devices.length && config.adb.wireless) {
    await run(config.adb.path, ["connect", config.adb.wireless], { timeoutMs: config.adb.timeoutMs });
    devices = await list();
  }

  if (!devices.length) {
    return {
      ok: false,
      state: "DISCONNECTED",
      serial: null,
      model: null,
      devices,
      hint: "no Android device: connect the phone by USB, enable Developer options → USB debugging, and accept the RSA prompt on the phone",
    };
  }

  const wanted = config.adb.serial
    ? devices.find((device) => device.serial === config.adb.serial)
    : devices.find((device) => !device.isEmulator && device.state === "device") ||
      devices.find((device) => device.state === "device");

  if (config.adb.serial && !wanted) {
    return {
      ok: false,
      state: "DISCONNECTED",
      serial: null,
      model: null,
      devices,
      hint: `ADB_DEVICE_SERIAL=${config.adb.serial} is not attached; configured devices: ${devices.map((d) => d.serial).join(", ")}`,
    };
  }

  if (!wanted) {
    const unauthorized = devices.find((device) => device.state === "unauthorized");
    return {
      ok: false,
      state: unauthorized ? "UNAUTHORIZED" : "DISCONNECTED",
      serial: unauthorized?.serial ?? null,
      model: unauthorized?.model ?? null,
      devices,
      hint: unauthorized
        ? "the phone is attached but not authorized: unlock it and tap Allow on the USB debugging prompt"
        : "no usable phone found (emulators cannot place real SIM calls)",
    };
  }

  if (wanted.state === "unauthorized") {
    return {
      ok: false,
      state: "UNAUTHORIZED",
      serial: wanted.serial,
      model: wanted.model,
      devices,
      hint: "the phone is attached but not authorized: unlock it and tap Allow on the USB debugging prompt",
    };
  }

  if (wanted.state !== "device") {
    return {
      ok: false,
      state: "DISCONNECTED",
      serial: wanted.serial,
      model: wanted.model,
      devices,
      hint: `phone ${wanted.serial} is ${wanted.state}; reconnect the cable or run: adb reconnect`,
    };
  }

  return { ok: true, state: "CONNECTED", serial: wanted.serial, model: wanted.model, devices, hint: null };
}

/** Current call state: IDLE | RINGING | IN_CALL | DISCONNECTED | UNKNOWN. */
export async function getCallState(config, { run = runProcess } = {}) {
  const device = await deviceStatus(config, { run });
  if (!device.ok) return { ok: false, state: "DISCONNECTED", device };

  const registry = await runAdb(config, buildCallStateArgs(config), { run });
  let state = parseCallState(registry.stdout);
  if (state === "UNKNOWN") {
    const telecom = await runAdb(config, [...buildCallStateArgs(config).slice(0, -1), "dumpsys", "telecom"], { run });
    state = parseCallState(telecom.stdout);
  }
  return { ok: true, state, device, raw: registry.stdout.slice(0, 400) };
}

async function waitForState(config, wanted, timeoutMs, { run, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "UNKNOWN";
  while (Date.now() < deadline) {
    const result = await getCallState(config, { run });
    last = result.state;
    if (wanted.includes(last)) return { reached: true, state: last, device: result.device };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { reached: false, state: last };
}

/** Place an outbound call and wait until the other side answers. */
export async function dial(config, number, { run = runProcess, waitForAnswer = true } = {}) {
  const device = await deviceStatus(config, { run });
  if (!device.ok) {
    return { ok: false, code: "no-device", state: device.state, error: device.hint, device };
  }

  const args = buildDialArgs(config, number);
  const started = await runAdb(config, args, { run });
  const output = `${started.stdout}\n${started.stderr}`;
  if (started.spawnError) {
    return { ok: false, code: "adb-spawn-failed", state: "DISCONNECTED", error: started.stderr || "could not start adb", command: args.join(" ") };
  }
  if (/error|exception|securityexception|not allowed/i.test(output)) {
    return { ok: false, code: "dial-rejected", state: "UNKNOWN", error: output.trim().slice(0, 500), command: args.join(" ") };
  }

  if (!waitForAnswer) {
    return { ok: true, code: "dialing", state: "DIALING", device, command: args.join(" ") };
  }

  const watch = await waitForState(config, ["IN_CALL", "RINGING"], config.dialTimeoutMs, { run });
  if (watch.state === "IN_CALL") {
    return { ok: true, code: "in-call", state: "IN_CALL", answered: true, device, command: args.join(" ") };
  }
  if (watch.state === "RINGING") {
    return {
      ok: false,
      code: "no-answer",
      state: "RINGING",
      answered: false,
      device,
      error: `the number is ringing but nobody answered within ${Math.round(config.dialTimeoutMs / 1000)}s`,
      command: args.join(" "),
    };
  }
  return {
    ok: false,
    code: "dial-failed",
    state: watch.state,
    answered: false,
    device,
    error: `the dialer did not report an active call (state: ${watch.state}). Check that the SIM is inserted, has credit, and the phone is not in airplane mode.`,
    command: args.join(" "),
  };
}

/** End the current call, with a keyevent fallback for ROMs without `telecom`. */
export async function hangup(config, { run = runProcess } = {}) {
  const current = await getCallState(config, { run });
  if (!current.ok) return { ok: false, code: "no-device", state: current.state, error: current.device?.hint };
  if (current.state === "IDLE") return { ok: true, code: "already-idle", state: "IDLE" };

  const viaTelecom = await runAdb(config, buildHangupArgs(config), { run });
  if (!viaTelecom.ok || /exception|error|unknown/i.test(`${viaTelecom.stdout}${viaTelecom.stderr}`)) {
    const serialArgs = config.adb.serial ? ["-s", config.adb.serial] : [];
    await runAdb(config, [...serialArgs, "shell", "input", "keyevent", "6"], { run });
  }

  const watch = await waitForState(config, ["IDLE"], 8000, { run, pollMs: 700 });
  return { ok: watch.reached, code: watch.reached ? "hung-up" : "hangup-unconfirmed", state: watch.state };
}

/** Answer an incoming call (used by the optional auto-answer daemon). */
export async function answer(config, { run = runProcess } = {}) {
  const accepted = await runAdb(config, buildAnswerArgs(config), { run });
  if (!accepted.ok) {
    const serialArgs = config.adb.serial ? ["-s", config.adb.serial] : [];
    await runAdb(config, [...serialArgs, "shell", "input", "keyevent", "5"], { run });
  }
  const watch = await waitForState(config, ["IN_CALL"], 8000, { run, pollMs: 700 });
  return { ok: watch.reached, state: watch.state };
}

/** Battery, carrier and signal, for the readiness report. */
export async function telemetry(config, { run = runProcess } = {}) {
  const device = await deviceStatus(config, { run });
  if (!device.ok) return { ok: false, state: device.state, hint: device.hint };
  const [battery, operator] = await Promise.all([
    runAdb(config, [...(config.adb.serial ? ["-s", config.adb.serial] : []), "shell", "dumpsys", "battery"], { run }),
    runAdb(config, [...(config.adb.serial ? ["-s", config.adb.serial] : []), "shell", "getprop", "gsm.operator.alpha"], { run }),
  ]);
  const level = battery.stdout.match(/level:\s*(\d+)/)?.[1];
  return { ok: true, model: device.model, serial: device.serial, battery: level ? Number(level) : null, operator: operator.stdout.trim() || null };
}
