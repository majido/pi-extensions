---
description: Clean up, commit, open a draft PR, then babysit CI + reviews with exponential backoff
argument-hint: "[stop|status|focus]"
---

## Subcommand dispatch

The first argument `$1` selects the action. Anything else is treated as a focus hint.

- `$1` == `stop` → **Stop mode** (see below). Optional `$2` = a specific stateKey or
  repo/PR to stop; otherwise stop all sitters.
- `$1` == `status` → **Status mode**: read every `~/.cache/pr-sitter/*.json` and print
  a compact summary (state, decisions pending, last/next check). Do not change anything.
- otherwise → **Start mode** (Phase 1 + arm Phase 2). Treat `$@` as a cleanup focus hint.

### Stop mode

1. List state files: `ls ~/.cache/pr-sitter/*.json 2>/dev/null`.
2. Determine targets: if `$2` is given, match it against the stateKey / repo / PR; else
   target all.
3. For each target, cancel its scheduled job and remove its state:
   - Find the job via the `schedule_prompt` tool (`action: "list"`), match
     `name == "pr-sitter-<stateKey>"`, then `action: "remove"` with that `jobId`.
   - Delete the state file: `rm ~/.cache/pr-sitter/<stateKey>.json`.
4. Report which sitters were stopped. The status widget clears automatically once the
   state files are gone.

If there are no sitters, say so and stop.

---

## Start mode (default)

You are running the **pr-sitter** bootstrap. This command has two phases:
**Phase 1 (now)** prepares the change and opens the PR. **Phase 2 (later)** is a
self-rescheduling monitor loop that watches CI and review comments. This command
does Phase 1 and then arms Phase 2.

Optional argument: `$@` — a focus hint for cleanup, or a target branch name.

## Operating rules (apply throughout)

- Branch naming: `mvalipour/<feature-description>`. Never operate on `master`/`main`.
- Push only to `mvalipour/*` branches. Never force-push over a branch you do not own.
- Prefer **new commits** over amends. Never rewrite already-pushed history.
- Never auto-merge.
- Conventional Commit titles. Use the `commit` skill for commit messages.
- Olympus repos need **two PRs** (dev/staging + production). If this is an Olympus
  change, do not silently open one PR — stop and tell me it needs the dual-PR flow.
- Use the `pull-requests` skill for Hopper PR conventions when available.

## Phase 1 — Cleanup, commit, PR

1. **Identify context.**
   - Repo root, current branch, remote for the Hopper upstream (often `hopper`).
   - GitHub login: `gh api user --jq '.login' | sed 's/_hopper$//'`.
   - Confirm there are uncommitted or unpushed changes to ship. If the tree is clean
     and a branch is already pushed, skip to "open/find PR".

2. **Cleanup pass with autofix.** Run the `/parallel-cleanup autofix` workflow on the
   current diff (two fresh-context reviewers: deslop + verbosity; apply only
   "fixes worth doing now"; do not apply optional improvements). If `$@` looks like a
   focus hint, pass it as the cleanup scope.

3. **Validate.** Run the project's build/test/lint as appropriate (read
   `package.json`/`AGENTS.md` to choose: pnpm scripts, `uv run ruff ... && uv run pytest`,
   `sbt --client`, `bazelisk`, etc.).
   - If validation **fails because of an autofix change**, revert the offending autofix
     and re-validate. Do not commit broken code.
   - If validation fails for a pre-existing reason unrelated to the cleanup, note it and
     continue (it will show up in CI anyway).

4. **Branch + commit.**
   - If on `master`/`main`, create `mvalipour/<desc>` first.
   - Stage intended files and commit using the `commit` skill (Conventional Commit title).

5. **Pre-PR hygiene.** Rebase onto the upstream main branch
   (`git fetch <hopper-remote>` then `git rebase <hopper-remote>/master` or `/main`).
   Resolve conflicts; if conflicts are non-trivial or risky, stop and ask me.

6. **Push + open draft PR.**
   - Push the branch to the Hopper upstream.
   - Open a **draft** PR with a clear title and a body summarizing what changed and why.
     Reuse the repo PR template if present.
   - Capture the PR number, URL, and `owner/repo`.

7. **Initialize sitter state.** Write the monitor state file so Phase 2 can dedup:

   ```bash
   mkdir -p ~/.cache/pr-sitter
   ```

   Create `~/.cache/pr-sitter/<owner>__<repo>__<pr>.json` with:

   ```json
   {
     "repo": "<owner>/<repo>",
     "prShort": "<repo>",
     "pr": <number>,
     "url": "<pr-url>",
     "branch": "<branch>",
     "cwd": "<repo-root-abs-path>",
     "state": "created",
     "intervalMin": 1,
     "seenCommentIds": [],
     "seenReviewIds": [],
     "checkConclusions": {},
     "needsDecision": [],
     "status": "watching",
     "cycles": 0,
     "startedAt": "<iso>",
     "lastActivityAt": null,
     "lastCheckAt": null,
     "nextCheckAt": "<iso + 1m>"
   }
   ```

   Use a stable `stateKey` = `<owner>__<repo>__<pr>` (sanitize `/` to `__`).

   **Ownership / scoping.** Set `cwd` to the absolute repo root (`pwd` /
   `git rev-parse --show-toplevel`). This scopes the status widget to the
   session/worktree that armed the sitter — the `pr-sitter-status` extension
   adopts the file by `cwd` and stamps a `sessionId` so it never bleeds into
   unrelated sessions. Do not hand-write `sessionId`; the extension owns it.

8. **Arm the monitor.** First run `schedule_prompt` with `action: "cleanup"` so old
   completed one-off sitter jobs are removed before creating another scheduled job.
   Then schedule the first monitor run in 1 minute using the `schedule_prompt` tool
   (inline mode — no `model` — so it wakes this session with full tools and context):

   - `action: "add"`, `type: "once"`, `schedule: "+1m"`
   - `name: "pr-sitter-<stateKey>"`
   - `prompt:` the literal text:
     `/pr-sitter-monitor <stateKey>`
   - `description`: short, e.g. `pr-sitter monitor for <owner>/<repo>#<pr>`

9. **Report.** Tell me: PR URL, what cleanup fixes were applied, validation result, and
   that the monitor is armed (first check in ~1 min, backoff up to 60 min).

If anything in Phase 1 is ambiguous or risky (conflicting rebase, unclear which files to
commit, Olympus dual-PR, no upstream remote), stop and ask before proceeding.
