---
name: ship
description: Drive a change through a staged quality pipeline — review, test, docs, lint, push, PR, CI, and review comments — for the current worktree. Use when asked to "ship this", "run the ship pipeline", "take this change to PR and babysit it", or when the ship extension spawns a pipeline/cycle run. Conductor skill; each stage delegates to a standalone skill.
---

# Ship — quality pipeline conductor

You are the executor for a **ship** run. You drive the change in the current
worktree through staged quality gates and (once a PR is open) babysit CI and
review comments. You are the **single writer** in this worktree.

Pipeline: `review → test → docs → lint → push → PR → CI → comments`

Read this whole skill before acting. The ship extension renders your progress
to the user from `state.json`, so keeping that file current is part of the job.

## Execution model (important)

Ship uses **fresh runs per cycle**, not one long-lived session. There are two
phases:

- **Phase 1 — pipeline** (`review → test → docs → lint → push → pr`): one run,
  start to finish. No pausing except to escalate a decision.
- **Phase 2 — monitoring** (`ci`, `comments`): one **fresh** run per cycle. Each
  cycle you reconstruct context from `state.json` + `journal.md` + `git`/`gh`,
  do exactly one cycle of work, update state, and reschedule the next cycle (the
  ship extension arms it). Assume **zero** memory carried between cycles.

Because a later cycle is a fresh session, **write down anything the next cycle
needs**: append to `journal.md` and keep `state.json` accurate. Never assume you
remember what a previous cycle did — read it.

## Reporting status (use the tools — never hand-write state.json)

The ship extension tells you `runId` and the state dir. **Do not edit
`state.json` directly.** Report through the provided tools; their handlers own
the write, so status is always well-formed and the user's live view stays
accurate:

- **`ship_stage(stage, status, note)`** — call at the START of each stage
  (`status: running`) and again when it finishes (`done`/`failed`/`skipped`).
  The `note` is a short one-liner shown live to the user: **present tense while
  running** ("adding RTFallbackSpec…"), **past tense when done** ("added
  RTFallbackSpec; verify green"). Call it promptly on every transition — the
  footer reflects exactly what you last reported.
- **`ship_decision_required(stage, what, tradeoff?, suggestion?)`** — escalate a
  design-level/ambiguous item; records it and pauses the run.
- On the **`pr`** stage, pass **`pr_url`** to `ship_stage` when the PR is open
  (repo + number are auto-extracted). There is no separate phase to set — the
  stage statuses are the source of truth for where the run is.

Still maintain two files directly:

- **`journal.md`** — append-only narrative. Each stage/cycle: what you tried,
  decisions and rationale, and your mid-stage position if you stop partway. This
  is the memory bridge across fresh cycles and the audit trail. (`ship_stage`
  appends a line automatically; add richer context yourself.)
- **`<stage>.md`** — each stage's detailed output (e.g. `review.md`, `test.md`,
  `pr-body.md`) in the state dir.

Liveness is tracked by the extension from the runtime independently of you, so a
forgotten final transition won't strand the footer — but report faithfully
anyway so the mid-run view is correct. Read `instructions[]` from `state.json`
at the start of every run (user steering) and honor it.

## Operating rules (always)

- Work on a feature branch you own. Never operate on `master`/`main`; if you're
  on the default branch, create a feature branch first. Follow any branch-naming
  convention from the repo's or your `AGENTS.md`.
- **Push only to a branch you own.** Prefer **new commits** over amends. Never
  force-push, never rewrite pushed history, never auto-merge.
- Conventional Commit titles via the `commit` skill.
- If the repo uses a non-standard release/PR flow (e.g. paired PRs per
  environment), don't guess — record a `needsDecision` and stop.
- **Comment attribution:** follow the attribution convention in your
  `AGENTS.md`, if any, when posting PR/issue comments or review replies.
- Only act autonomously on **straightforward** work. Anything design-level,
  ambiguous, risky, or scope-expanding → `needsDecision` and stop that item.

## needsDecision & steering

- To escalate: call `ship_decision_required(stage, what, tradeoff?, suggestion?)`,
  note it in `journal.md`, and stop working that item. The tool pauses the run
  and the extension notifies the user.
- The user's answer arrives as an entry in `instructions[]` on your next spawn
  (or via live steer during a running stage). Read `instructions[]` at the start
  of every run and honor it.

## Stages

Load the referenced skill (via the read tool) when you reach each stage. Respect
`.pi/ship.json` config (stage list, per-stage `model`/`verify`/`optional`,
`--only`/`--from` scoping the extension passes in).

### 1. review — load `code-review-and-quality`
Review the current diff across correctness, tests, simplicity, security. Fix
**clear wins** yourself; record architectural/ambiguous findings as
`needsDecision`. Loop review→fix at most **2** iterations, then move on (or
escalate if still blocked). Artifact: `review.md`.

### 2. test — load `verify-change`
Audit coverage for the diff's changed behaviors, write missing tests for the
intended behavior, run targeted suites, then the floor `verify` command. Fix
**code** to pass — never weaken tests. Also decide which PR-specific tests
matter and add/adjust them. Artifact: `test.md` (what you picked and why).

### 3. docs — load `documentation-and-adrs` (+ `repo-wiki` if the repo has one)
QA this PR's documentation surface: (a) update docs the diff made stale
(README, wiki pages, code comments); (b) review docs **added** in this PR (ADRs,
wiki pages, doc comments) for accuracy and quality; (c) flag a missing ADR/wiki
page — write it if clear-cut, else `needsDecision`. Then run new/updated prose
through the `humanizer` skill's heuristics before finishing. Artifact: `docs.md`.

### 4. lint — verify command only (no skill)
Run the project's lint/format. Apply **mechanical** fixes only. Anything a
linter can't fix mechanically is out of scope here.

### 5. push — load `commit`
Stage the intended files, commit with a Conventional Commit title. Rebase onto
the upstream default branch if needed (stop and escalate on non-trivial
conflicts). Push with `git push origin HEAD` to your own feature branch.
Autonomous in v1 (no confirm gate).

### 6. pr — load `pull-requests`
Open a **draft** PR: clear title, body summarizing what changed and why, reuse
the repo template if present. Report it via `ship_stage("pr", "done", note, pr_url=<url>)` — repo/number are
extracted from the URL. Autonomous in v1. If the repo needs a non-standard
multi-PR release flow, escalate via `ship_decision_required` instead. Artifact:
`pr-body.md`. Completing the `pr`
stage marks the transition into monitoring; the extension arms the first CI
cycle.

### 7. ci — load `ci-triage-fix` (Phase 2, per cycle)
One cycle: fetch checks, dedup against `ci.checkConclusions`, fix straightforward
failures (validate + new commit + push), escalate the rest. Update
`ci.checkConclusions`, `ci.cycles`, and backoff (`intervalMin`: new activity → 1,
else `min(interval*2, 60)`). Reschedule unless paused/stopped.

### 8. comments — load `pr-comment-triage-fix` (Phase 2, per cycle)
One cycle: fetch review activity, dedup against `seenCommentIds`/`seenReviewIds`,
apply clear wins (validate + commit + push + attributed reply), escalate
design-level ones. Update the seen sets.

CI and comments run together each Phase-2 cycle. Stop conditions: PR merged or
closed, or `ci.cycles >= 200`. Downgrade to idle (max 60m interval) when all
checks are green, review is approved, and nothing is unresolved.

## Per-run checklist

1. Read `state.json` + `journal.md` + `instructions[]`; reconcile with
   `git log`/`git diff`/`gh` so you know exactly where things stand.
2. Do the current phase's work (Phase 1: continue the pipeline; Phase 2: one
   cycle).
3. Report progress via `ship_stage` (with `pr_url` on the pr stage) and append
   `journal.md`.
4. Escalate blockers via `ship_decision_required` and stop them; keep going on
   the rest.
5. Report a concise status line. In Phase 2, ensure the next cycle is armed (or
   explain why you stopped).

## Red flags

- Hand-editing `state.json` instead of calling `ship_stage`/`ship_decision_required`
- Assuming memory across cycles instead of reading `journal.md`/`state.json`
- Leaving a stage note stale (not calling `ship_stage` on transition)
- Auto-doing design-level work instead of escalating
- Pushing without local validation, or to a branch you don't own
- Posting a reply that ignores the repo's comment/attribution conventions
