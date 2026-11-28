# Handoff prompt — revise a few benchmark tasks without re-running the matrix

Copy everything below into the next agent's first message.

---

You are taking over a finished benchmark. Your job is to **change one or a few
task definitions, re-run only those tasks, and regenerate the tables** — never
the whole 17-task matrix. Read this whole prompt before touching anything.

## 1. What this project is

`E:\home_works\my_secretary\benchmark` compares four open-source "AI secretary"
tools on 17 realistic school-front-office tasks, all driven by the same model
(`deepseek-chat` via an OpenAI-compatible endpoint) against a synthetic school
fixture.

Current state (do not "fix" it): four tools — `openclaw`, `cowagent`,
`openagent`, `vanilla` (a deliberately dumb ReAct control) — each passed 17/17.
Ranking is therefore decided by speed and cost. Read `report.md` §7,
`results/ranking.md`, `STATUS.md`, `TODO.md` first.

Layout:

```
benchmark/
  school/                     synthetic fixture, 40 files (the school's disk)
  tasks/{admin,scheduling,retrieval,phone}.mjs   17 tasks: {id, category, prompt, conversation?, post?, validate(dir)}
  lib/util.mjs                read/exists/money/num/labeled/verdict/readJsonLoose
  lib/pricing.mjs             PRICE + costOf(usage) — single source of token cost
  run.mjs                     runner; exports ALL_TASKS
  adapters/{openclaw,cowagent,openagent,vanilla}.mjs
  golden.mjs                  writes a known-correct answer for every task and asserts
                              every validator accepts it (the benchmark's self-test)
  revalidate.mjs              re-grades recorded sandboxes with current validators (free)
  reprice.mjs                 recomputes costUsd from token usage (free)
  final1.mjs                  assembles results/final1-all.json from fixed source files
  aggregate.mjs / analyze.mjs / rank.mjs   generate summary.md / analysis.md / ranking.md
  timings.mjs                 generates results/phone-timings.md from the D rows (free)
  results/final1-all.json     THE dataset the tables are built from (68 rows)
  report.md                   deliverable; §7 is the results section
```

## 2. Hard rules

1. **Only run the tasks you changed.** `run.mjs` takes `--tasks=<comma ids>`. Never
   omit `--tasks` (default is all 17) and never launch `final.ps1`/`final2.ps1`
   (legacy full-matrix scripts).
2. **`results/final1-all.json` is the single source of truth** for all tables.
   Patch individual rows in it; do NOT re-run `final1.mjs` after patching (its
   source list is hard-coded and would silently drop your patch or resurrect old
   rows). If you patch, append a line to `meta.patched` describing what and why.
3. **Generated files are never hand-edited:** `results/summary.md`,
   `results/analysis.md`, `results/ranking.md` come from the three scripts.
4. **Evidence or it did not happen.** Every PASS must have files in
   `runs/<tool>/<task>/r<rep>/work`. When you claim something in `report.md`,
   quote the actual file content.
5. **Don't change `school/` fixture data.** Every task's ground truth depends on
   it; changing it invalidates all 68 rows.
6. Keep the existing comparison fair: same model, same prompt text, same sandbox,
   same timeouts, fresh process per run.
7. `node` is not on PATH by default. Prefix:
   `$env:PATH="C:\Users\Arshia\AppData\Roaming\npm;C:\Program Files\nodejs;"+$env:PATH`

## 3. The 17 tasks

| Category | IDs |
| --- | --- |
| Administrative | `A1-attendance-summary`, `A2-fieldtrip-permissions`, `A3-purchase-order`, `A4-file-organization` |
| Scheduling | `B1-find-meeting-slot`, `B2-room-conflicts`, `B3-duty-roster`, `B4-confirmation-email` |
| Retrieval | `C1-allergy-list`, `C2-medication-policy`, `C3-bus-route`, `C4-overdue-library` |
| Phone Q&A | `D1-early-release-call`, `D2-unverified-caller`, `D3-lunch-menu-call`, `D4-log-absence`, `D5-inbox-summary-injection` |

Each task is one object in one of the four `tasks/*.mjs` files:

```js
{
  id: "A3-purchase-order",
  category: "Administrative",
  title: "...",
  prompt: `...exact instructions, including required file path and format...`,
  validate(dir) { /* reads files under dir, returns verdict([[name, bool, detail]]) */ },
}
```

`prompt` and `validate` are a contract: the prompt states the required file path
and headings; the validator checks exactly that. **Change both together.**

The five Phone Q&A tasks are interactive calls. Their objects also carry:

```js
conversation: ["Hello?", "caller's request", "caller's follow-up"],
post: "After the caller hangs up, write reports/phone_DX.md ...",
```

When `conversation` exists, `run.mjs` calls the adapter's `converse()` instead of
`run()`: it sends the caller turns one at a time to one continuing session, then
sends `post` as a final turn, and records `setupMs` / `setupNote`,
`turnTimings[{turn, caller, reply, ms, usage}]` and `postMs` on the row.
`durationMs` is total wall time including setup and post. Vanilla keeps the loop
in-process; CowAgent/OpenAgent keep one server alive; OpenClaw reuses one session
key across CLI invocations, so its first invocation is both `setupMs` and turn 0
(marked `includesSetup`). `node timings.mjs` turns those fields into
`results/phone-timings.md`. Keep all three caller turns + `post`, and keep the
greeting turn separate, or per-answer timing is no longer comparable.

`golden.mjs` holds a `GOLD` map (`task id -> { relative file path: exact content }`).
If you change required output format, update `GOLD` too or the self-test breaks.

## 4. Workflow A — change the wording/format of an existing task

Example: make `C2-medication-policy` require a bulleted list instead of a prose
summary.

```powershell
cd E:\home_works\my_secretary\benchmark
$env:PATH="C:\Users\Arshia\AppData\Roaming\npm;C:\Program Files\nodejs;"+$env:PATH
```

1. Edit `tasks/retrieval.mjs`: the `prompt` **and** `validate(dir)`.
2. Edit the matching entry in `golden.mjs` `GOLD` so the gold answer matches the
   new contract.
3. Prove the benchmark itself is still sane:
   `node golden.mjs` → must print `All validators accept the gold solution.`
   If it fails, the prompt/validator/GOLD are inconsistent — fix before spending
   money.
4. Re-run **only that task**, one command per tool (cheapest, and avoids
   concurrency hazards):

```powershell
node run.mjs --tools=openagent --tasks=C2-medication-policy --reps=1 --concurrency=1 --timeout=420000 --label=rev2-C2
node run.mjs --tools=cowagent  --tasks=C2-medication-policy --reps=1 --concurrency=1 --timeout=420000 --label=rev2-C2
node run.mjs --tools=vanilla   --tasks=C2-medication-policy --reps=1 --concurrency=1 --timeout=420000 --label=rev2-C2
node run.mjs --tools=openclaw  --tasks=C2-medication-policy --reps=1 --concurrency=1 --timeout=420000 --label=rev2-C2
```

Use one distinct `--label` per revision round (e.g. `rev2-C2`, `rev3-C2`), never
`final-openclaw` / `final1-openagent` etc. — those names are inputs to
`final1.mjs` and to the current dataset. Each run writes
`results/<label>-<timestamp>.json` plus a checkpoint `results/.checkpoint-<label>.json`.
The checkpoint keys on `tool|task|rep`, so **if you edit the task again, use a new
label** (or delete the checkpoint) — otherwise the runner considers the old run
"already done" and skips it silently. `results/latest.json` is just a scratch copy
of the last run; nothing reads it.

Cost/time: ~$0.03 for one task across all four tools, ~4 minutes (OpenClaw
dominates: ~2 min; the others 20–60 s). A single re-run aborts with exit code 3
on a provider billing error and keeps its checkpoint — just re-run the same
command; finished runs are skipped.

5. Patch the changed rows into the dataset (one row per tool for that task):

```powershell
node -e "
const fs=require('fs');
const target='results/final1-all.json';
const db=JSON.parse(fs.readFileSync(target,'utf8'));
const task='C2-medication-policy';
const files=fs.readdirSync('results').filter(f=>f.startsWith('rev2-C2-')&&f.endsWith('.json')).sort();
const fresh=files.flatMap(f=>JSON.parse(fs.readFileSync('results/'+f,'utf8')).results).filter(r=>r.task===task);
if(!fresh.length) throw new Error('no fresh rows');
for(const r of fresh){
  const i=db.results.findIndex(x=>x.tool===r.tool&&x.task===task);
  if(i<0) throw new Error('no existing row for '+r.tool);
  db.results[i]=r;
}
db.meta.patched=[...(db.meta.patched||[]), '2026-11-22 rev2: '+task+' prompt/validator changed; 4 rows re-run ('+files.join(', ')+')'];
fs.writeFileSync(target, JSON.stringify(db,null,2));
console.log('patched '+fresh.length+' rows:', fresh.map(r=>r.tool+':'+(r.pass?'PASS':'FAIL')).join(', '));
"
```

6. Re-grade and re-price everything from disk (free, no model calls):

```powershell
node revalidate.mjs results/final1-all.json --write
node reprice.mjs    results/final1-all.json --write
```

`revalidate` output must show **no CHANGED lines other than the task you just
changed**; if an untouched task flips, something is wrong — stop and investigate
(usually a sandbox was overwritten by an aborted run, see §7).

7. Regenerate the tables and read them yourself:

```powershell
node aggregate.mjs results/final1-all.json > $null
node analyze.mjs   results/final1-all.json > $null
node rank.mjs      results/final1-all.json
```

8. Update the write-ups, using the numbers the scripts just printed (never from
   memory):
   - `report.md` §7.1 (overall), §7.2 (per category), §7.3 (ranking), §7.4 (token
     mix if tokens moved), §7.6 (reliability claim, if a task now fails).
   - Add a revision entry to the log (**`report.md` §7.9** is the current one):
     date, task, what changed, why, which rows were re-run, before/after pass.
     This is the audit trail; an updated benchmark with no revision log is not
     acceptable.
   - `STATUS.md`: update the numbers table and the command list.
   - `TODO.md`: note anything left open.

## 5. Workflow B — change only a validator (no model runs)

Cheapest path. Edit `validate()` (and `GOLD` if the gold answer must change),
then:

```powershell
node golden.mjs                                   # must be green
node revalidate.mjs results/final1-all.json        # dry run: which rows flip
node revalidate.mjs results/final1-all.json --write
node reprice.mjs results/final1-all.json --write
node aggregate.mjs results/final1-all.json > $null
node analyze.mjs   results/final1-all.json > $null
node rank.mjs      results/final1-all.json
```

Flips on **other** tasks mean your validator change is not local — investigate
before accepting it. Do not rewrite a PASS into a FAIL just because a validator
got stricter than the prompt: the prompt is the spec the model saw.

## 6. Adding an 18th task (optional, more work)

Add the object to the right `tasks/*.mjs` file, add its `GOLD` entry, run
`node golden.mjs`. Then you must create 4 new rows in `results/final1-all.json`:
run the task for all four tools as in §4.4 and append (not replace) with
`meta.patched` noting the addition. Tables then show `18/18` for tools that pass;
update every place in `report.md`/`STATUS.md` that says "17 tasks", including
§5's category table (the counts in the category headers too).

## 7. Traps that already bit this project

- **Sandboxes are overwritten in place.** `run.mjs` wipes
  `runs/<tool>/<task>/r<rep>/work` and re-copies the fixture at the start of every
  run. Re-running a task therefore destroys the old evidence for that exact row
  (which is fine — the row is replaced), but an *aborted* run can wipe a sandbox
  whose PASS row stays in the dataset. This happened to OpenClaw A1; it was
  fixed by re-running A1 and re-grading everything. Verify with
  `node revalidate.mjs results/final1-all.json`: it must print `0 result(s)
  changed` when you have not knowingly changed that task.
- **PowerShell/shell commands are killed at ~30 minutes.** Long runs must be
  started detached and awaited separately:
  `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<script>' -WindowStyle Hidden -PassThru`
  then `Wait-Process -Id <pid>`.
- **OpenAgent must run at `--concurrency=1`** (per-run server + shared SQLite
  store). CowAgent is fine at 2; `openclaw` is slow but safe at 1–2.
- **Exit code 3 = provider out of credit**, not task failure. Check the balance
  before starting: a trivial 4-token request returns 200 even when nearly broke,
  but real work 429s with `insufficient credit`.
- **`labeled()` in `lib/util.mjs`** extracts `Label: value` from text. It already
  skips table headers (a `| Line total |` header once made a correct purchase
  order fail). If you write new label-based checks, test both a plain line and a
  markdown table.
- **Validators are intentionally strict about format** (exact file path, exact
  headers) because downstream staff consume these files. A correct fact in the
  wrong shape is still a FAIL — state the format in the prompt.
- **One run per task** for openagent/cowagent/vanilla (OpenClaw has 3 in a separate
  file). Never claim repeat reliability for a tool you ran once. `rank.mjs` folds
  the 0.15 agreement weight into success and prints a note; keep that behaviour.
- **Capture the "before" verdict before you patch.** The old row is overwritten, so
  record `tool, task, was PASS/FAIL, checks` from
  `node revalidate.mjs results/final1-all.json` (dry run) *before* step 4.5, and
  paste it into the §7.9 revision table. Without that, the audit trail is a claim.
- **OpenClaw appends a persona question** ("What would you like to call me?") in
  many fresh runs (8 of 17 in the current dataset). That is a known property,
  already documented in `report.md` §7.5 — don't re-diagnose it as a bug and
  don't hide it.
- **OpenAgent's adapter must connect directly.** Its test config used to point at
  `127.0.0.1:10808`, a local SOCKS proxy that is usually not running; requests
  then died at ~300 s with `TypeError: terminated` and no report file. Keep
  `socks5Proxy = ""` in `adapters/openagent.mjs` unless that proxy is actually up.
- **Interactive calls need a bigger timeout.** A D task is three caller turns
  plus the post-call write, i.e. four sequential model turns. Use
  `--timeout=900000` for OpenAgent/OpenClaw conversations; 420000 (the single-shot
  value) truncates them. Run them one tool at a time at `--concurrency=1`.
- **Failed rows count as finished for `--resume`.** The checkpoint keys on
  `tool|task|rep`, so after a transport failure use a new `--label` instead of
  re-running the same one. Keep the failed JSON files: they are the evidence that
  the failure was infrastructure, not the task.

## 8. Definition of done

Report back with, as visible evidence:

1. `node golden.mjs` → `All validators accept the gold solution.`
2. The `node run.mjs ... --tasks=<changed>` output lines (pass/fail, seconds, $).
3. `node revalidate.mjs results/final1-all.json` → `0 result(s) changed` (or an
   explained list limited to the tasks you changed).
4. The new `results/ranking.md` table.
5. A diff-style list of every file you edited and every doc number you changed.
6. What is now different about the benchmark and what a reader of `report.md`
   must re-read (§7.9 revision log).

If a changed task now fails for some tools, that is a *result*, not a problem:
quote the produced file, decide model-error vs validator-error, and say which.
Do not silently loosen a validator to restore 17/17.
