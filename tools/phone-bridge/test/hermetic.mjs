// Import this first in every test file.
//
// The suite must be hermetic: a green run should not depend on the developer's
// shell. `PHONE_CONFIG` (the real, gitignored `phone.config.json` with the pinned
// models and allowlist), `AVAL_API_KEY`, `PHONE_ALLOW_DIAL` and `PHONE_SIMULATE`
// all change what `loadConfig()` returns, so inheriting them turns a passing test
// into a machine-dependent one — which is exactly what happened when the phone
// config was exported while running `node --test test/`.

for (const name of ["PHONE_CONFIG", "AVAL_API_KEY", "AVALAI_API_KEY", "PHONE_ALLOW_DIAL", "PHONE_SIMULATE", "PHONE_ALLOWLIST", "PHONE_MAX_CALLS", "PHONE_TTS_ENGINE", "PHONE_STT_ENGINE", "PHONE_TOOL"]) {
  delete process.env[name];
}

export const HERMETIC = true;
