# Done — final matrix (1 rep per tool)

All steps below are complete; evidence is in `results/` and written up in
`report.md`.

## Conversation revision (2026-11-22): D1–D5 are interactive calls

- [x] Rewrote `tasks/phone.mjs` D1–D5 as three caller turns + one post-call
      write (`conversation`, `post`); reframed D5 as an inbox rundown call
- [x] Added `converse()` to all four adapters and dispatch/timing fields to
      `run.mjs` (`setupMs`, `turnTimings`, `postMs`)
- [x] Updated `GOLD` for D1–D4; `node golden.mjs` green before and after
- [x] Re-ran only the 20 D cells, one tool at a time, `--reps=1
      --concurrency=1` — 20/20 PASS
- [x] Patched the 20 rows into `results/final1-all.json` (`meta.patched`); the
      48 non-D rows are untouched; `node final1.mjs` was not re-run
- [x] `revalidate.mjs`: 0 changed; `reprice.mjs --write`: total $0.4989
- [x] Regenerated `summary.md`, `analysis.md`, `ranking.md` (aggregate /
      analyze / rank only)
- [x] `results/phone-timings.md` with setup and per-answer timings (`timings.mjs`)
- [x] `report.md` §7.1–§7.6, §7.8, new §7.9 revision log and §7.10 timing

## Original matrix

- [x] OpenAgent 1-rep run (17/17) — `results/final1-openagent-*.json`
- [x] CowAgent 1-rep run (17/17) — `results/final1-cowagent-*.json`
- [x] Vanilla revalidated pilot (17/17) — `results/pilot-vanilla.json`
- [x] OpenClaw 3 reps (51/51) — `results/final-openclaw-2026-11-19T07-44-57.json`
- [x] D2 re-run under the final prompt (OpenClaw + Vanilla, both PASS) —
      `results/d2-all-2026-11-19T09-02-26.json`
- [x] OpenClaw A1 re-run after an aborted resume wiped its sandbox —
      `results/a1fix-2026-11-19T09-08-03.json`
- [x] Assemble 1-rep dataset — `results/final1-all.json` (68 runs)
- [x] Re-grade every row from its sandbox (`revalidate.mjs --write`): 0 mismatches
- [x] Re-price every row from the provider's price table (`reprice.mjs --write`)
- [x] Tables + ranking — `results/summary.md`, `analysis.md`, `ranking.md`
- [x] `report.md` §7 (results, cost, reliability, grading fixes, recommendation)
- [x] `STATUS.md` rewritten for the finished state

## Re-running after a task change (hand-off prompt)

`NEXT-AGENT.md` is a self-contained prompt for whoever revises the benchmark
next: edit one task (`prompt` + `validate()` + `GOLD`), keep `node golden.mjs`
green, re-run only that task with `--tasks=<id>`, patch the 4 rows into
`results/final1-all.json` with a `meta.patched` note, then regenerate
`summary.md` / `analysis.md` / `ranking.md` without any model spend.

## If more credit becomes available (optional, not blocking)

`node run.mjs --tools=openagent,cowagent,vanilla --reps=3 --label=reps3` would
restore the repeat-reliability term (0.15) in the ranking. At current prices a
full 3-rep set for the three tools costs roughly $0.85–1.00.

## Guardrails that should stay

- `node golden.mjs` must print "All validators accept the gold solution."
- `node revalidate.mjs results/final1-all.json` must print 0 changed rows.
- `run.mjs` exits 3 on a provider billing error so a checkpoint is never polluted
  with fake task failures.
