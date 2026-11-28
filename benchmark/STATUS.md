# Benchmark status — DONE (conversation revision)

Final comparison is complete. Deliverable: `report.md`. Evidence:

| File | What it proves |
| --- | --- |
| `results/final1-all.json` | 68 graded runs: 4 tools × 17 tasks, 1 run each; 20 Phone Q&A rows are interactive calls |
| `results/summary.md` | overall + per-category + per-task tables |
| `results/analysis.md` | same, plus token mix and failure list (none) |
| `results/ranking.md` | weighted ranking |
| `results/phone-timings.md` | setup, every caller turn and the post-call write, all 20 calls |
| `results/final-openclaw-2026-11-19T07-44-57.json` | OpenClaw 3 reps × 17 tasks = 51/51 PASS (single-shot set) |
| `results/a1fix-2026-11-19T09-08-03.json` | OpenClaw A1 re-run that replaced a sandbox wiped by an aborted resume |
| `results/conv-D-2026-11-22*.json`, `results/revD-*.json` | the interactive D1–D5 runs, including failed infrastructure attempts |

## Final numbers

| Rank | Tool | Score | Pass | Median s | USD / run |
| --- | --- | --- | --- | --- | --- |
| 1 | VanillaAgent (control) | 0.974 | 17/17 | 19.7 | 0.0106 |
| 2 | OpenAgent 2.89.2 | 0.945 | 17/17 | 43.5 | 0.0051 |
| 3 | CowAgent d5c17e0 | 0.933 | 17/17 | 42.7 | 0.0070 |
| 4 | OpenClaw 2026.11.5 | 0.903 | 17/17 | 142.2 | 0.0066 |

Total for the 68-run comparison dataset: **$0.4989**.

Phone Q&A interacts in three caller turns plus one post-call write. Mean answer
time (T0+T1+T2): Vanilla 18.3 s, CowAgent 37.6 s, OpenAgent 161.3 s, OpenClaw
226.6 s. Setup is separate: 0 / 2.1 / 4.1 s, and 73.0 s for OpenClaw's first
invocation (which also contains its greeting). Details: `results/phone-timings.md`.

## How it was produced

```
node golden.mjs                                            # validators accept gold
powershell -File final.ps1        # phase 1 (was killed by a 30-min shell cap)
powershell -File final2.ps1       # phase 2: openagent resume + cowagent
powershell -File d2.ps1           # D2 re-run for openclaw + vanilla
node final1.mjs                   # assemble -> results/final1-all.json

# conversation revision (2026-11-22): only the 20 Phone Q&A rows
node run.mjs --tools=vanilla,cowagent --tasks=D1-early-release-call,D2-unverified-caller,D3-lunch-menu-call,D4-log-absence,D5-inbox-summary-injection --reps=1 --concurrency=1 --timeout=600000 --label=conv-D-2026-11-22
node run.mjs --tools=openagent --tasks=D2-unverified-caller,D3-lunch-menu-call,D4-log-absence,D5-inbox-summary-injection --reps=1 --concurrency=1 --timeout=900000 --label=conv-D-2026-11-22r3
node run.mjs --tools=openagent --tasks=D1-early-release-call --reps=1 --concurrency=1 --timeout=900000 --label=revD-openagent-D1
node run.mjs --tools=openclaw --tasks=D1-early-release-call,D4-log-absence,D5-inbox-summary-injection --reps=1 --concurrency=1 --timeout=900000 --label=revD-openclaw2

node revalidate.mjs results/final1-all.json                # 0 changed
node reprice.mjs results/final1-all.json --write           # cost from the price table
node aggregate.mjs results/final1-all.json
node analyze.mjs results/final1-all.json
node rank.mjs results/final1-all.json
node timings.mjs                                           # results/phone-timings.md
```

The D rows were patched into `results/final1-all.json` from the newest passing
run per tool/task; `final1.mjs` was not re-run.

## Fixes made during the run (all evidence-backed)

1. `run.mjs` aborts a phase with exit code 3 on a provider billing error instead
   of recording it as a task failure (`results/evidence-openagent-429.log`).
2. `revalidate.mjs --write` re-grades old sandboxes after a validator change.
3. `lib/util.mjs` `labeled()` no longer stops at a table header
   ("| Line total |") and return an empty value; this had falsely failed
   CowAgent's correct purchase order.
4. OpenAgent's test config pointed at `127.0.0.1:10808`, a local SOCKS proxy that
   was not running. That caused the ~300 s `TypeError: terminated` rows. The
   adapter now connects directly; D1 passed in 263.2 s with clean turns.
5. OpenClaw A1 was re-run after an aborted resume wiped its sandbox, so every
   PASS has files behind it.
6. The D5 prompt now tells the tool to read the six inbox files directly;
   OpenAgent had been scanning the whole workspace (one call took 119 s). D5 was
   re-run on all four tools, all PASS.
7. OpenClaw's D1 attempt in `revD-openclaw` exited before writing a file; the
   rerun in `revD-openclaw2` passed. The failed attempt is kept in `results/`.

## Revising the benchmark later

`NEXT-AGENT.md` is a ready-to-paste prompt for the next agent. It covers editing
one task's `prompt` / `conversation` / `post` / `validate()` / `GOLD` entry,
re-running only that task (`node run.mjs --tasks=<id> --reps=1`), patching the row
into `results/final1-all.json`, and the no-cost chain that rewrites the tables
(`revalidate --write`, `reprice --write`, `aggregate`, `analyze`, `rank`,
`timings`).

## Open caveat

One run per task for the conversation rows (OpenClaw's single-shot set has three
reps). Repeat agreement cannot be measured for the other tools, so its 0.15
weight is folded into success. With money available,
`node run.mjs --tools=openagent,cowagent,vanilla --reps=3 --label=reps3` would
restore the repeat-reliability term.
