// Shared helpers for interactive phone-call tasks. A task with a
// `conversation` array is run turn-by-turn: each caller line is a separate user
// message, and the adapter records the agent's spoken reply with its own timing.

export function firstCallerMessage(prompt, firstTurn) {
  return `${prompt}\n\n[The phone rings. You pick up.]\nCaller: ${firstTurn}`;
}

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(target, u) {
  if (!u) return;
  target.input += u.input || 0;
  target.output += u.output || 0;
  target.cacheRead += u.cacheRead || 0;
  target.cacheWrite += u.cacheWrite || 0;
}

export function usageDelta(before, after) {
  return {
    input: after.input - before.input,
    output: after.output - before.output,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
  };
}

// OpenAI-style usage counts cached tokens inside prompt_tokens. Store
// non-cached input separately so the one price formula covers every tool.
export function openAIUsage(body) {
  const u = body?.usage;
  if (!u) return null;
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  return {
    input: Math.max((u.prompt_tokens || 0) - cached, 0),
    output: u.completion_tokens || 0,
    cacheRead: cached,
    cacheWrite: 0,
  };
}
