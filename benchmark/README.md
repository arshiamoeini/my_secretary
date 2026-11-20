# Maplewood front-office benchmark

A single, deterministic task suite used to compare open-source personal
assistant tools on realistic school-secretary work.

## Fixture

`school/` is a synthetic K-5 elementary school ("Maplewood Elementary") with
40 students, staff roster, attendance for two days, health records, a library
loan register, a calendar with deliberate room conflicts, a budget, a policy
handbook, a bell schedule, a lunch menu, scanned documents, permission slips and
an inbox (including one phishing / prompt-injection email).

Everything is plain text or CSV so any tool can read it without extra parsers.
Each run gets a **fresh copy** of `school/`, so nothing leaks between runs or
between tools.

## Tasks

17 tasks in four categories, each with a deterministic validator:

| Category | IDs | What it measures |
| --- | --- | --- |
| Administrative | A1-A4 | attendance summary, permission audit, purchase order with budget check, document filing |
| Scheduling | B1-B4 | slot finding under multi-party constraints, conflict detection, roster construction, draft email |
| Retrieval | C1-C4 | allergy list, policy summary, route lookup, overdue-fine arithmetic |
| Phone Q&A | D1-D5 | early-release hours, privacy verification, menu, absence logging, inbox triage with injection |

Validators parse the files the agent was asked to produce and check facts
against the fixture. `golden.mjs` writes a known-correct solution for every task
and asserts that all 17 validators accept it, which guards against broken
grading.

## Metrics

* **success** - validator pass rate per task (programmatic checks on the files
  the tool actually wrote)
* **autonomy** - runs that end by asking the user a question instead of finishing
* **reliability** - agreement between repeated runs of the same task, error count
  (measurable for OpenClaw only: 3 reps; the other tools have 1)
* **speed** - wall-clock per run (process startup included, since every tool pays it)
* **cost** - tokens x the single model's list price (`lib/pricing.mjs`)

## Fairness rules

* One model for every tool: `deepseek-chat` on the same OpenAI-compatible
  endpoint, so only the scaffolding differs.
* Same prompt text, same sandbox, same timeout.
* The control is `vanilla.mjs`: the same model in a ~180-line ReAct loop with
  read/write/list/shell tools and no assistant framework.
* Process startup is inside the measured window for every tool.

## Running

```bash
node golden.mjs                                   # verify the validators
node run.mjs --tools=openclaw,vanilla --reps=1     # pilot
node run.mjs --tools=openclaw,cowagent,openagent,vanilla --reps=1 --concurrency=2
node revalidate.mjs results/<run>.json [--write]  # re-grade old sandboxes after a validator change
node merge.mjs --out=results/final.json --replace=D2-unverified-caller \
  results/final-openclaw.json --patch=results/d2-rerun.json
node final1.mjs                                   # assemble 1-rep/all-tool dataset -> results/final1-all.json
node aggregate.mjs results/final1-all.json         # full tables -> results/summary.md
node analyze.mjs results/final1-all.json           # evidence tables -> results/analysis.md
node rank.mjs results/final1-all.json              # weighted ranking -> results/ranking.md
```

`run.mjs` checkpoints after every run and takes `--resume`: a phase that dies
(credit exhaustion, timeout) keeps its finished runs and continues where it
stopped. A provider billing error aborts the phase with exit code 3 instead of
being recorded as a task failure.

Ranking weights (see `rank.mjs`): success 0.55, repeat reliability 0.15,
autonomy 0.15, speed 0.10, cost 0.05. In the single-rep run the 0.15
reliability weight is folded into success (effective: success 0.70), because
agreement cannot be measured from one run per task. `rank.mjs` prints a note and
a `Reps` column so the reader can see which regime a table came from.

Per-tool drivers live in `adapters/` (`openclaw.mjs`, `cowagent.mjs`,
`openagent.mjs`, `vanilla.mjs`); the fixture is `school/` and each run gets a
fresh copy under `runs/<tool>/<task>/r<rep>/work`, which is what the validators
grade and what `revalidate.mjs` can re-grade later for free.
