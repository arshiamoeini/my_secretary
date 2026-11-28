// Append-only audit trail plus the active-call session.
//
// The session lives in a small JSON file so the CLI and the agent (separate
// Node processes) see the same call. Every real or simulated call is recorded
// in calls.jsonl, and the full transcript is archived when the call ends.

import fs from "node:fs";
import path from "node:path";

function auditFile(config) {
  return path.join(config.auditDir, "calls.jsonl");
}

export function appendCallRecord(config, record) {
  const file = auditFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  return file;
}

export function readCallRecords(config, limit = 50) {
  const file = auditFile(config);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  return lines
    .slice(-Math.max(1, limit))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { malformed: line.slice(0, 200) };
      }
    });
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function readSession(config) {
  try {
    return JSON.parse(fs.readFileSync(config.sessionFile, "utf8"));
  } catch {
    return null;
  }
}

export function writeSession(config, session) {
  writeJsonAtomic(config.sessionFile, session);
  return config.sessionFile;
}

export function clearSession(config) {
  try {
    fs.unlinkSync(config.sessionFile);
  } catch {
    // already gone
  }
}

/** Archive the finished call so the transcript survives the session file. */
export function saveCallTranscript(config, session) {
  const dir = path.join(config.auditDir, "calls");
  const file = path.join(dir, `${session.id}.json`);
  writeJsonAtomic(file, session);
  return file;
}
