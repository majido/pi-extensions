---
name: ci-triage-fix
description: Triage failing CI checks on a pull request and fix the straightforward ones. Use when a PR has red/changed checks, when watching CI after a push, or when asked to "fix CI", "triage the build failure", "the pipeline is red", or "address failing checks". Fixes mechanical failures autonomously; escalates design-level ones.
---

# CI Triage & Fix

Given a pull request with failing or changed CI checks, diagnose each one,
fix the straightforward failures, and escalate the rest. Keep changes minimal
and always re-validate before pushing.

## Inputs you need

- `repo` (`owner/repo`) and PR number (or current branch's PR).
- The branch you own and may push to. **Only push to branches you own**
  (e.g. `mvalipour/*`); never force-push, never rewrite pushed history,
  never auto-merge.

## 1. Fetch current check state

```bash
gh pr checks <pr> -R <repo>
gh pr view <pr> -R <repo> --json state,isDraft,mergeable,statusCheckRollup,url
```

For a failing check, get the detail:

```bash
gh run view <run-id> --log-failed          # GitHub Actions
# or open the check details URL for non-Actions checks (Atlantis, Harness, etc.)
```

## 2. Dedup (when running in a monitor loop)

If you are tracking state across cycles, a check is **new activity** only when
its `conclusion` differs from what you last recorded (e.g. `null`→`failure`, or
`success`→`failure`). Pending/still-running checks with no conclusion change are
not new activity — do not act on them.

## 3. Classify each failure

**Straightforward — fix autonomously:**

- Lint / formatting (scalafmt, ruff, prettier, eslint, buildifier)
- Type errors with an obvious fix (missing import, wrong signature, null guard)
- Obvious test failures (off-by-one, stale assertion, wrong fixture)
- Snapshot / golden-file updates that are clearly correct
- Missing generated code (proto/codegen re-run)
- Dependency pin / lockfile drift with a mechanical resolution

**Not straightforward — escalate, do not guess:**

- Failures implying a design change or a real behavioral regression
- Flaky/infra failures unrelated to the diff (note it; don't "fix" by retrying blindly)
- Anything ambiguous, cross-cutting, or scope-expanding
- Security / auth / data-migration failures

Escalate by recording a concise `needsDecision` entry: what failed, where, the
tradeoff, and a suggested option. Then stop acting on that item.

## 4. Fix, validate, push

For each straightforward failure:

1. Make the minimal fix in source.
2. Validate locally with the project's own build/test/lint (read
   `package.json` / `AGENTS.md`: pnpm scripts, `uv run ruff … && uv run pytest`,
   `sbt --client "scalafmtAll; test"`, `bazelisk`, etc.).
3. If validation fails, iterate — do not push broken code.
4. Commit as a **new commit** (Conventional Commit title; use the `commit`
   skill) and push to your branch (`git push origin HEAD`).

Never weaken, skip, or delete a test to make CI green. If a test is genuinely
wrong, fixing it is a code change with its own justification — record why.

## 5. Report

One line per action: what check failed, what you changed, commit subject, and
whether it's pushed. List any `needsDecision` items separately.

## Red flags

- Pushing without a local validation pass
- "Fixing" a flaky test by re-running until green
- Broadening scope beyond the failing check
- Amending or force-pushing already-pushed commits
