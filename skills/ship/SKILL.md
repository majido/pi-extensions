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

## State files (in `.pi/ship/<runId>/`)

The ship extension tells you `runId` and the state dir. Two files are yours to
maintain:

- **`state.json`** — machine state the extension renders. Update:
  - `stage` and the matching `stages[].status` (`pending`→`running`→`done`/`failed`/`skipped`)
  - `stages[].note` — a short one-liner: **present tense while running**
    ("adding RTFallbackSpec…"), **past tense when done** ("added RTFallbackSpec;
    verify green"). This is what the user sees.
  - `needsDecision[]`, `pr`, `ci`, `seenCommentIds`/`seenReviewIds` as relevant
  - Consume `instructions[]` (user steering for this spawn) on read, then clear it
  - Write atomically (write temp + rename) so the watcher never sees half a file.
- **`journal.md`** — append-only narrative. Each stage/cycle: what you tried,
  decisions and rationale, and your mid-stage position if you stop partway. This
  is the memory bridge across fresh cycles and the audit trail.

Also write each stage's detailed output to `<stage>.md` in the state dir
(e.g. `review.md`, `test.md`, `pr-body.md`); reference it from
`stages[].artifact`.

## Operating rules (always)

- Branch naming `mvalipour/<feature-description>`. Never operate on
  `master`/`main`. If on the default branch, create the feature branch first.
- **Push only to branches you own** (`mvalipour/*`). Prefer **new commits** over
  amends. Never force-push, never rewrite pushed history, never auto-merge.
- Conventional Commit titles via the `commit` skill.
- **Olympus repos need two PRs** (dev/staging + production). If this is an
  Olympus change, do not silently open one — record a `needsDecision` and stop.
- **Agent attribution:** every PR/issue comment or review reply you post starts
  with `🤖 **<Model>**: ` (short model name: `Claude`, `GPT`, `Gemini`).
- Only act autonomously on **straightforward** work. Anything design-level,
  ambiguous, risky, or scope-expanding → `needsDecision` and stop that item.

## needsDecision & steering

- To escalate: append to `state.json.needsDecision[]` with `{ stage, what,
  tradeoff, suggestion }`, set `status: "paused"`, note it in `journal.md`, and
  stop working that item. The extension notifies the user.
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
conflicts). Push with `git push origin HEAD` to your `mvalipour/*` branch.
Autonomous in v1 (no confirm gate).

### 6. pr — load `pull-requests`
Open a **draft** PR: clear title, body summarizing what changed and why, reuse
the repo template if present. Capture PR number, URL, `owner/repo` into
`state.json.pr`. Autonomous in v1. If Olympus → dual-PR `needsDecision` instead.
Artifact: `pr-body.md`. End of Phase 1: set `phase: "ci"`, initialize
`ci.intervalMin = 1` and `ci.nextCheckAt`, and let the extension arm the first
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
3. Update `state.json` (stage, notes, dedup, decisions) atomically and append
   `journal.md`.
4. Escalate blockers to `needsDecision` and stop them; keep going on the rest.
5. Report a concise status line. In Phase 2, ensure the next cycle is armed (or
   explain why you stopped).

## Red flags

- Assuming memory across cycles instead of reading `journal.md`/`state.json`
- Leaving `stages[].note` stale so the user's view lies
- Auto-doing design-level work instead of escalating
- Pushing without local validation, or to a branch you don't own
- Posting a reply without the `🤖 **<Model>**:` attribution
