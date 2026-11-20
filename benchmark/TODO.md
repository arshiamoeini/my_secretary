# Done — final matrix (1 rep per tool)

All steps below are complete; evidence is in `results/` and written up in
`report.md`.

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

## If more credit becomes available (optional, not blocking)

`node run.mjs --tools=openagent,cowagent,vanilla --reps=3 --label=reps3` would
restore the repeat-reliability term (0.15) in the ranking. At current prices a
full 3-rep set for the three tools costs roughly $0.85–1.00.

## Guardrails that should stay

- `node golden.mjs` must print "All validators accept the gold solution."
- `node revalidate.mjs results/final1-all.json` must print 0 changed rows.
- `run.mjs` exits 3 on a provider billing error so a checkpoint is never polluted
  with fake task failures.
