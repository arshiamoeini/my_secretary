// Active-call session helpers. One call at a time, on purpose: a secretary has
// one phone line, and a stale second session is how accidental double-dials
// happen.

import { readSession, writeSession } from "./store.mjs";

let dialCounter = 0;

/** Tests only. */
export function resetCallCount() {
  dialCounter = 0;
}

export function newSessionId(prefix = "call") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  dialCounter += 1;
  return `${prefix}-${stamp}-${dialCounter}`;
}

export function createSession({ id, number, simulated, script = [] }) {
  return {
    id,
    simulated: Boolean(simulated),
    number: { national: number.national, e164: number.e164, kind: number.kind },
    state: simulated ? "SIMULATED" : "IN_CALL",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
    script,
    scriptIndex: 0,
    recordings: [],
    warnings: [],
  };
}

export function loadSession(config) {
  const session = readSession(config);
  if (!session || !session.id) return null;
  return session;
}

export function persist(config, session) {
  session.updatedAt = new Date().toISOString();
  if (session.turns.length > 400) session.turns = session.turns.slice(-400);
  writeSession(config, session);
  return session;
}

export function addTurn(session, speaker, text, extra = {}) {
  const clean = String(text ?? "").trim();
  if (!clean) return session;
  session.turns.push({ at: new Date().toISOString(), speaker, text: clean, ...extra });
  return session;
}

export function transcriptText(session) {
  return (session?.turns ?? []).map((turn) => `${turn.speaker === "agent" ? "AI" : turn.speaker === "caller" ? "Caller" : "System"}: ${turn.text}`).join("\n");
}

export function durationSeconds(session) {
  const started = Date.parse(session?.startedAt || "");
  if (!Number.isFinite(started)) return 0;
  return Math.round((Date.now() - started) / 1000);
}
