---
description: pr-sitter monitor cycle — checks CI + reviews, fixes or escalates, then reschedules
argument-hint: "<stateKey>"
---

You are running one **pr-sitter monitor cycle** for stateKey `$1`. This prompt is
invoked by a scheduled job and re-arms itself with exponential backoff. Do exactly
one cycle, then reschedule (or stop).

## Operating rules (same as bootstrap)

- Push only to `mvalipour/*` branches. Prefer **new commits** over amends. Never
  force-push, never auto-merge, never rewrite pushed history.
- Conventional Commit titles via the `commit` skill.
- Only act autonomously on **straightforward** fixes. Anything ambiguous, risky,
  design-level, or scope-changing goes to `needsDecision` and pauses the loop.
- **Agent attribution.** Any comment or review reply you post on the PR MUST
  start with the `🤖 **<Model>**: ` prefix (see the global "Agent attribution"
  rule in AGENTS.md). Example:
  `🤖 **Claude**: good catch. I addressed feedback in commit abc123`.

## 1. Load state

```bash
cat ~/.cache/pr-sitter/$1.json
```

If the file is missing, the sitter was cancelled — stop silently (do not reschedule).
Parse: `repo` (`owner/repo`), `pr`, `branch`, `intervalMin`, `seenCommentIds`,
`seenReviewIds`, `checkConclusions`, `needsDecision`, `cycles`.

## 2. Fetch current PR state

Use `gh` against `repo` and `pr`:

- PR state + mergeable + review decision:
  `gh pr view <pr> -R <repo> --json state,isDraft,mergeable,reviewDecision,url`
- Check runs / statuses:
  `gh pr checks <pr> -R <repo>` (and/or
  `gh api repos/<repo>/commits/<branch-head-sha>/check-runs`)
- Review comments (inline) and issue comments and reviews:
  - `gh api repos/<repo>/pulls/<pr>/comments` (inline review comments, has `id`)
  - `gh api repos/<repo>/issues/<pr>/comments` (conversation comments, has `id`)
  - `gh api repos/<repo>/pulls/<pr>/reviews` (review submissions, has `id`, `state`, `body`)

## 3. Detect NEW activity (dedup)

- **New comments** = comment/review ids not in `seenCommentIds`/`seenReviewIds`.
  Ignore comments authored by me (the PR author / `gh api user`).
- **Changed checks** = any check run whose `conclusion` differs from
  `checkConclusions[name]` (e.g. went `null`→`failure`, or `success`→`failure`).
- `hadNewActivity` = (any new comment) OR (any changed check conclusion).

Pending/still-running CI with no conclusion change is **not** new activity.

## 4. Stop conditions (check before doing work)

Stop the loop (do NOT reschedule) and report if:

- PR `state` is `MERGED` or `CLOSED` → report final status, then stop.
- `cycles` >= 200 (hard safety cap) → report and stop, tell me to re-arm if wanted.

Downgrade to idle (reschedule at max 60m, no further action this cycle) if:

- All checks green AND `reviewDecision` is `APPROVED` AND no unresolved/new comments.
  Keep watching in case new commits/reviews land, but quietly.

## 5. Act on new activity

For each **failed/changed check**:
- Pull the failing job logs (`gh run view --log-failed` or the check details URL).
- If the fix is **straightforward** (lint/format, type error, obvious test fix,
  import, simple null guard, snapshot update), fix it locally, validate with the
  project's build/test/lint, commit (new commit, `commit` skill), and push to
  `mvalipour/*`.
- If not straightforward → add a concise entry to `needsDecision`.

For each **new review comment/review**:
- If it's a clear, low-risk request (rename, comment, small refactor, obvious bug,
  doc tweak) → apply it, validate, commit, push. Optionally reply to the thread
  noting it's addressed — every reply must start with the `🤖 **<Model>**: `
  attribution prefix (see Operating rules), e.g.
  `🤖 **Claude**: good catch. I addressed feedback in commit abc123`.
- If it's a design choice, disagreement, ambiguous, or scope change → add to
  `needsDecision` with the comment text, author, file/line, and a one-line summary
  of the tradeoff.

Never apply every suggestion blindly. Keep changes minimal and validated.

## 6. Update state + compute next interval

- Add all newly seen comment/review ids to `seenCommentIds`/`seenReviewIds`.
- Update `checkConclusions` to the current conclusions.
- Increment `cycles`. Set `lastActivityAt` if `hadNewActivity`.
- Set `lastCheckAt` = now (ISO). This drives the status bar.
- Set `state` to one of the canonical states the status bar understands (pick the
  single most relevant): `created`, `checks-running`, `ci-failure`, `fixing`,
  `changes-requested`, `awaiting-approval`, `needs-decision`, `approved`,
  `merged`, `closed`. Use `fixing` only transiently while you are pushing a fix
  this cycle; otherwise reflect the resting state. Use `needs-decision` whenever
  `needsDecision` has unresolved entries.
- Set `prShort` = the repo name without owner (for compact display), keep `url`.
- **Backoff:**
  - If `hadNewActivity` → `intervalMin = 1` (reset).
  - Else → `intervalMin = min(intervalMin * 2, 60)`.
  - (Sequence: 1, 2, 4, 8, 16, 32, 60, 60, …)
- If `needsDecision` gained new entries this cycle → set `status = "paused"`.
- Compute `nextCheckAt`:
  - If you will reschedule: now + `intervalMin` minutes (ISO).
  - If paused or stopping: set `nextCheckAt` to null.

Write the updated JSON back to `~/.cache/pr-sitter/$1.json`. **Preserve the
existing `cwd` and `sessionId` fields unchanged** — they scope the status widget
to the owning session and must survive every rewrite. If `cwd` is missing
(legacy file from before scoping existed), backfill it with the current repo root
(`git rev-parse --show-toplevel`) so the widget can scope this sitter. Never
write `sessionId` yourself; the extension stamps it. The pr-sitter status bar
extension reads `state`, `prShort`, `pr`, `lastCheckAt`, `nextCheckAt`,
`needsDecision`, `status`, `cwd`, and `sessionId` from this file.

## 7. Reschedule or pause

- **If `needsDecision` has unresolved entries (status `paused`):**
  Do NOT reschedule. Notify me in chat with the list of decisions needed (each:
  what, where, the tradeoff, and a suggested option). Tell me that after I decide,
  I can resume with `/pr-sitter-monitor $1` and the loop re-arms.

- **Otherwise (status `watching`):** Before arming the next cycle, run `schedule_prompt`
  with `action: "cleanup"` so completed one-off sitter jobs do not accumulate. Then arm
  the next cycle with `schedule_prompt`:
  - `action: "add"`, `type: "once"`, `schedule: "+<intervalMin>m"`
  - `name: "pr-sitter-$1"`
  - `prompt:` `/pr-sitter-monitor $1`
  - `description:` `pr-sitter monitor for <repo>#<pr> (next in <intervalMin>m)`

## 8. Report (concise)

One short status line plus any actions taken this cycle:
`#<pr> <repo> — checks: <summary>, new comments: <n>, fixes pushed: <n>, next: <intervalMin>m`
List any pushed fixes (commit subjects) and any `needsDecision` items.
