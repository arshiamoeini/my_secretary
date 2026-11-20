# Benchmark status — DONE

Final comparison is complete. Deliverable: `report.md`. Evidence:

| File | What it proves |
| --- | --- |
| `results/final1-all.json` | 68 graded runs: 4 tools × 17 tasks, 1 run each |
| `results/summary.md` | overall + per-category + per-task tables |
| `results/analysis.md` | same, plus token mix and failure list (none) |
| `results/ranking.md` | weighted ranking |
| `results/final-openclaw-2026-11-19T07-44-57.json` | OpenClaw 3 reps × 17 tasks = 51/51 PASS |
| `results/a1fix-2026-11-19T09-08-03.json` | OpenClaw A1 re-run that replaced a sandbox wiped by an aborted resume |

## Final numbers

| Rank | Tool | Score | Pass | Median s | USD / run |
| --- | --- | --- | --- | --- | --- |
| 1 | VanillaAgent (control) | 0.972 | 17/17 | 17.6 | 0.0097 |
| 2 | OpenAgent 2.89.2 | 0.949 | 17/17 | 36.0 | 0.0043 |
| 3 | CowAgent d5c17e0 | 0.924 | 17/17 | 42.7 | 0.0064 |
| 4 | OpenClaw 2026.11.5 | 0.896 | 17/17 | 121.2 | 0.0067 |

Total for the 68-run comparison dataset: **$0.4606** (OpenClaw's separate 3-rep
set: $0.4014).

## How it was produced

```
node golden.mjs                                            # validators accept gold
powershell -File final.ps1        # phase 1 (was killed by a 30-min shell cap)
powershell -File final2.ps1       # phase 2: openagent resume + cowagent
powershell -File d2.ps1           # D2 re-run for openclaw + vanilla
node final1.mjs                   # assemble -> results/final1-all.json
node revalidate.mjs results/final1-all.json --write        # re-grade from sandboxes
node reprice.mjs results/final1-all.json --write           # cost from the price table
node aggregate.mjs results/final1-all.json
node analyze.mjs results/final1-all.json
node rank.mjs results/final1-all.json
```

## Fixes made during the run (all evidence-backed)

1. `run.mjs` aborts a phase with exit code 3 on a provider billing error instead
   of recording it as a task failure (`results/evidence-openagent-429.log`).
2. `revalidate.mjs --write` re-grades old sandboxes after a validator change.
3. `lib/util.mjs` `labeled()` no longer stops at a table header
   ("| Line total |") and return an empty value; this had falsely failed
   CowAgent's correct purchase order.
4. Four network-aborted OpenAgent rows (`TypeError: terminated`, ~310 s) were
   pruned from the checkpoint and re-run rather than counted as failures.
5. OpenClaw A1 was re-run after an aborted resume wiped its sandbox, so every
   PASS has files behind it.

## Open caveat

One run per task (OpenClaw has three). Repeat agreement cannot be measured for
the other three tools, so its 0.15 weight is folded into success. With money
available, `node run.mjs --tools=openagent,cowagent,vanilla --reps=3 --label=reps3`
would restore the repeat-reliability term.
