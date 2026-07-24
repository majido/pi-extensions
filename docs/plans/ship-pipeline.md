# Ship Pipeline — pi extension plan

Status: design finalized (spike + oracle review complete), implementation in progress
Date: 2026-07-23

A pi extension + skill set that drives a staged quality pipeline for the change
in the current worktree:

```
review → test → docs → lint → push → PR → CI check → comment address
```

Independent of pr-sitter; duplicates the logic it needs and is intended to
eventually **replace pr-sitter**.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Execution model | **Fresh-run-per-cycle.** Phase 1 (review→test→docs→lint→push→pr) runs as ONE async subagent spawn (`context: "fork"`, single writer). Phase 2 (ci, comments) runs as fresh subagent spawns per cycle, self-rescheduled via `schedule_prompt` subagent mode. state.json + journal.md are the continuity anchors. No resume-based scheduling. |
| Why not persistent executor | Verified: pi-subagents `resume`/`steer`/`stop`/`scheduledRuns` are all hard-scoped to the spawning sessionId (see Spike findings). Cross-session control of a live run is impossible by design; a persistent executor strands permanently if its session dies. |
| Liveness | **Accepted (permanent v1):** no CI action while zero pi sessions are open in this worktree. Mitigation: catch-up-on-attach (see below). Escalation path (separate pi process via cmux + intercom) stays closed unless true unattended operation becomes a requirement. |
| Fix loop | Executor auto-fixes clear wins; architectural/ambiguous items go to `needsDecision` and the cycle ends (pr-sitter escalation grammar). Answering a decision seeds the next fresh spawn. |
| Gates | **None in v1** — push, PR, and comment replies proceed autonomously (with 🤖 attribution on replies). Per-stage `gate: "confirm"` stays in the config schema for later. |
| Skill structure | One `ship` skill as conductor; each stage is a short instruction + reference to a standalone skill useful outside ship. |
| State location | Worktree-local: `<worktree>/.pi/ship/` (in global gitignore as `.pi/ship/`). Thin global index at `~/.pi/agent/ship/index.json`. |
| Visualization | Overlay panel with per-stage one-liners + slim footer status. |
| Steering | `s` in overlay / `/ship-steer` → `subagent steer` on the live current-cycle run (same-session only, which is inherently the case for a live run you're watching). Between cycles → instructions appended to state.json, picked up by next spawn. |

## Spike findings (2026-07-23, empirical)

1. **pi-subagents 0.35.1 resume bug**: every async `resume` fails —
   `resolveAcceptance()` stamps `explicit`/`inferredReason` onto the persisted
   descriptor, and the resume path re-validates it against the strict input
   schema which rejects those keys. Known upstream (#537), fixed by PR #558
   (merged 2026-07-20), unreleased as of 2026-07-23.
2. **Session-scoping wall (the decisive finding)**: `resume`, `steer`, `stop`,
   and `scheduledRuns` are all hard-scoped to the originating pi sessionId
   (`async-resume.ts`: throws "not found in the active session" when
   `options.sessionId !== status.sessionId`; executor always passes it). A new
   pi session in the same worktree can read a run's status but can never
   resume/steer it. Verified empirically on fixed `main` code.
3. Corroboration: pi-subagents' own `scheduledRuns` **rejects `context:"fork"`**
   ("Forked parent-session context is not safe at fire time") — the library
   itself mandates fresh context for deferred spawns.

Consequence: the original "Model A" (one long-lived executor resumed across CI
cycles) and the "supervisor lease adoption" mechanism are unbuildable. The
plan's documented fallback — fresh run per cycle, pr-sitter style — is promoted
to the permanent design (oracle-reviewed, endorsed).

## Architecture

```
┌─ user session ─────────────────────────────────────────┐
│  ship extension (orchestrator)                         │
│   • /ship, /ship-status, /ship-steer, /ship-abort,     │
│     /ship-list                                         │
│   • overlay + footer render state.json (fs-watch)      │
│   • catch-up-on-attach: session_start → nextCheckAt    │
│     in the past? → fire a cycle now                    │
└───────────────┬────────────────────────────────────────┘
                │
        Phase 1 │ one async subagent spawn, context:"fork"
                ▼
┌─ pipeline run (single spawn) ──────────────────────────┐
│  ship skill · single writer · runs review → test →     │
│  docs → lint → push → pr in one session                │
│  updates state.json + journal.md as it goes            │
│  ends by scheduling the first CI cycle                 │
└───────────────┬────────────────────────────────────────┘
                │
        Phase 2 │ fresh subagent spawn per cycle
                │ (schedule_prompt one-shot, subagent mode,
                │  session scope, backoff 1→2→4→…→60m)
                ▼
┌─ cycle run (fresh spawn, repeats) ─────────────────────┐
│  reads state.json + journal.md + git log/diff,         │
│  runs ONE ci/comments cycle, updates state + journal,  │
│  re-schedules itself or stops (merged/closed/paused)   │
└────────────────────────────────────────────────────────┘
```

### Cycle model (Phase 2, pr-sitter pattern)

Each cycle: load state → fetch PR/checks/comments → dedup against
`seenCommentIds`/`checkConclusions` → act (fix straightforward, escalate rest)
→ update state.json + append journal.md → re-schedule next cycle via
`schedule_prompt` (`type: "once"`, `+<intervalMin>m`) or stop.

- Backoff: new activity → 1m; none → `min(interval*2, 60)`.
- `needsDecision` non-empty → do NOT reschedule; notify user; the user's answer
  (via chat or overlay) seeds the next spawn.
- Stop: PR merged/closed, or cycles ≥ 200.
- Double-fire safety: `schedule_prompt` session scope means only the creating
  session fires — no lease needed. If workdir scope is ever adopted, add a
  per-cycle atomic claim (CAS on `{runId, cycle}` in state.json) — not built
  in v1.

### Continuity: state.json + journal.md

- `state.json` — machine state: stage statuses, notes, dedup sets, backoff,
  decisions. The render source for footer/overlay.
- `journal.md` — executor-appended narrative per cycle/stage: what it tried,
  decisions and rationale, mid-stage position. Recovers "accumulated memory"
  across fresh spawns, improves decision-resume fidelity, doubles as audit
  trail. **Hedge for the riskiest assumption** (state.json alone is too coarse
  to resume a partially completed stage).

### Steering

- Live cycle/pipeline run → `subagent { action: "steer", id, message }` from
  the session that spawned it (the only session that can — fine, since that's
  where you're watching).
- Between cycles / paused → `/ship-steer` appends to `state.json.instructions[]`;
  the next spawn reads and honors them.

## Stages

| Stage | Skill(s) | Notes |
|---|---|---|
| review | `code-review-and-quality` | Auto-fix clear wins; `needsDecision` for architectural. Review→fix loop capped at 2 iterations. |
| test | `verify-change` *(new)* | See below. |
| docs | `documentation-and-adrs` + `repo-wiki` (when present) + `humanizer` | QA on this PR's documentation surface: (1) update docs made stale by the diff (README, wiki pages, comments), (2) review docs *added* in the PR (ADRs, wiki pages, doc comments) for accuracy/quality, (3) flag missing ADR/wiki page — write if clear-cut, `needsDecision` if judgment call, (4) run new/updated prose through `humanizer` heuristics before finishing the stage. |
| lint | verify command only | Mechanical fixes only, no skill. |
| push | `commit` | Conventional commits, `git push origin HEAD`, `mvalipour/*` branches only. Autonomous in v1. |
| pr | `pull-requests` | Draft PR, repo template. Autonomous in v1. Olympus dual-PR → stop and ask. |
| ci | `ci-triage-fix` *(new)* | Fresh spawn per cycle with backoff. Straightforward fixes (lint, type error, obvious test fix, import, snapshot) applied + pushed; else `needsDecision`. |
| comments | `pr-comment-triage-fix` *(new)* | Clear, low-risk requests → fix + reply with `🤖 **<Model>**:` attribution. Design/scope items → `needsDecision`. |

### `verify-change` skill (new, standalone)

Not TDD — `test-driven-development` is a development methodology (red/green,
test-before-code) and wrong for a post-hoc stage. `verify-change` operates on an
existing diff:

1. **Coverage audit** — enumerate behaviors the diff adds/changes; each must
   have a test. Write missing tests for the *intended* behavior (they should
   pass immediately; a failing new test = bug found → fix code, not test).
2. **Targeted run** — select specs/suites relevant to this diff and run them;
   record what was picked and why in the stage artifact.
3. **Floor** — run the configured `verify` command (non-negotiable).
4. **Fix loop** — fix code to satisfy tests; never weaken/skip a test to go
   green. Failure revealing a design problem → `needsDecision`.

Borrows TDD's "writing good tests" guidance by reference.

### Operating rules (copied into `ship` skill, from pr-sitter)

- Branch naming `mvalipour/<desc>`; never operate on `master`/`main`; push only
  to `mvalipour/*`.
- New commits over amends; never force-push or rewrite pushed history; never
  auto-merge.
- Conventional Commit titles via `commit` skill.
- Olympus repos need dual PRs → stop and ask.
- Every posted comment/reply starts with `🤖 **<Model>**: `.

## State layout

```
<worktree>/.pi/ship/
├── current.json                 # { runId } pointer; absent = no active run
└── <runId>/
    ├── state.json
    ├── journal.md               # executor-appended, per cycle/stage
    ├── review.md                # stage artifacts
    ├── test.md
    ├── docs.md
    ├── pr-body.md
    └── …
```

- Scoping is structural: any pi session in the worktree computes the path from
  `cwd`. No sessionId stamping, no adoption logic, no cross-worktree bleed.
- Lifecycle follows the worktree: `/branch-done` removes state + artifacts.
- `.pi/ship/` is in the global gitignore.

Global index `~/.pi/agent/ship/index.json` (append on spawn, prune on
finish/orphan): `{ runId, cwd, startedAt }`. Used for `/ship-list` fleet view
and orphan detection (worktree deleted → prune entry, cancel any scheduled
job).

### state.json (draft)

```jsonc
{
  "runId": "2026-07-23-lodging-rt",
  "cwd": "/abs/worktree",
  "parentSessionFile": "…",          // provenance only
  "phase": "pipeline",               // pipeline | ci | done
  "currentRun": { "asyncId": "…", "asyncDir": "…", "spawnedBySessionId": "…" },  // live spawn, if any
  "stage": "docs",
  "status": "running",               // running | paused | waiting-ci | done | failed | aborted
  "stages": [
    { "id": "review", "status": "done", "model": "…", "startedAt": "…", "endedAt": "…",
      "note": "3 findings, 2 auto-fixed, 1 skipped", "artifact": "review.md" },
    { "id": "test",   "status": "running", "note": "adding RTFallbackSpec…" }
  ],
  "needsDecision": [
    { "stage": "review", "what": "…", "tradeoff": "…", "suggestion": "…" }
  ],
  "instructions": [],                // user steering for the NEXT spawn; consumed on read
  "pr": { "repo": "owner/repo", "number": 123, "url": "…" },   // once opened
  "ci": { "intervalMin": 4, "nextCheckAt": "…", "checkConclusions": {}, "cycles": 3 },
  "seenCommentIds": [], "seenReviewIds": []
}
```

Executor updates `note` per stage at start (present tense) and end (past
tense). Extension is a pure renderer + fs-watcher (poll fallback).

## Config

Per-project `.pi/ship.json` (fallback to extension defaults):

```jsonc
{
  "stages": [
    { "id": "review", "model": "…", "loopback": 2 },
    { "id": "test",   "verify": "sbt --client \"scalafmtAll; test\"" },
    { "id": "docs",   "optional": true },
    { "id": "lint",   "verify": "…" },
    { "id": "push" },                          // gate: "confirm" supported, default auto
    { "id": "pr" },
    { "id": "ci",     "maxCycles": 200 },
    { "id": "comments" }
  ]
}
```

`verify` is the floor; the executor additionally selects PR-specific tests
(see `verify-change`).

## Visualization

### Overlay (`/ship-status`, anchor right-center, ~45% width)

```
┌─ ship: fix-lodging-rt-fallback ──────── run 12m ─┐
│ ✓ review    opus    2m10s  3 findings, 2 auto-fixed, 1 skipped
│ ✓ test      sonnet  4m02s  added RTFallbackSpec; verify green
│ ● docs      haiku   0m41s  updating docs/wiki/translation.md…
│ ○ lint                     —
│ ○ push                     —
│ ○ pr                       —
│ ○ ci                       —
│ ○ comments                 —
├──────────────────────────────────────────────────┤
│ ⚠ 1 decision pending: review flagged API rename  │
│ ↑↓ stage · enter output · s steer · a abort ·    │
│ esc close                                        │
└──────────────────────────────────────────────────┘
```

- `enter` on stage → open its artifact
- `s` → input box → live steer (current-cycle run) or `instructions[]` append
- decisions section: `enter` to answer inline → seeds next spawn
- Footer status when overlay closed: `ship ● docs 3/8` (+ `⚠` when paused,
  `⏲ 4m` when waiting on CI)

### Multi-session attach (catch-up-on-attach)

Any pi session started in the worktree discovers the run via
`<cwd>/.pi/ship/current.json` on `session_start`:

- Footer status appears immediately; one-time notify:
  `ship run active — ctrl+shift+s to view`.
- `pi.registerShortcut("ctrl+shift+s")` opens the overlay.
- **Catch-up-on-attach**: if `ci.nextCheckAt` is in the past and no live run is
  recorded, this session fires a catch-up cycle immediately and becomes the
  scheduler (its `schedule_prompt` session-scoped jobs drive subsequent
  cycles). Reopening pi = instant recovery. No lease, no heartbeat: with
  session-scoped jobs only one session ever fires, and a dead session's jobs
  die with it — the next attach picks up from state.json.

## Commands

```
/ship [--only a,b] [--from stage] [--dry]
/ship-status        # overlay
/ship-steer <msg>
/ship-abort         # stop run + cancel scheduled cycles, keep artifacts
/ship-list          # fleet view across worktrees (via global index)
```

## Build order

1. ~~Spike~~ **done** — findings above; fresh-run-per-cycle confirmed as
   permanent model (oracle-reviewed).
2. **Skills:** `ci-triage-fix`, `pr-comment-triage-fix` (standalone, duplicated
   from pr-sitter-monitor §5, useful immediately), `verify-change`, then `ship`.
3. **Extension v1:** `/ship` + state file + footer status; Phase 1 stages.
   Steering via `/ship-steer`. **done.**
   - Reliability hardening: extension-owned `ship_stage`/`ship_decision_required`
     tools (agent calls, handler writes) + runtime-liveness reconciliation from
     `status.json` so the footer never shows a phantom "running". **done.**
   - Status overlay panel (`/ship-status`, `Ctrl+Shift+S`): per-stage rows (glyph,
     model, duration, one-liner), decisions, PR link, artifact viewer; keys
     `↑↓/enter/s/a/esc`. **done.**
4. **v2 (next):** push/pr + Phase 2 cycles (schedule_prompt wiring, backoff,
   catch-up-on-attach); global index; `/ship-list`.
5. **v3:** inline decision answering in the overlay; live same-session steer.
6. Retire pr-sitter after ship covers a real PR end-to-end.

Verification items for v2 (from oracle review):
- End-to-end check that `schedule_prompt` subagent-mode jobs load the `ship`
  skill + required context at fire time (`skills` param).
- Deliberate mid-stage pause/resume test to validate journal.md fidelity.

## Open items

- `gate: "confirm"` implementation (pause + resume-with-answer) — schema
  reserved, deferred.

Resolved: skill name is `verify-change` (not `test-verify`). Docs stage runs
`humanizer` in v1, not deferred. Orphan handling (worktree deleted while
executor live → cancel run via global index sweep) confirmed as designed.
Execution model revised to fresh-run-per-cycle after spike + oracle review
(2026-07-23); liveness gap accepted as permanent v1 behavior.
