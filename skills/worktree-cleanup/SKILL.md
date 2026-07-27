---
name: worktree-cleanup
description: Audit and clean up git worktrees and their branches across a repo — surfaces legacy/orphaned worktrees, cross-references GitHub PR status, and proposes safe deletions. Use when the user asks to "clean up worktrees", "audit worktrees", "list my worktrees", "which worktrees can I delete", or wants to prune stale branches left behind by manual `git worktree add` / other tooling (opencode, claude, treehouse). Not for creating worktrees — see the branch-worktree extension (/branch, /branch-and-split, /branch-done) for that.
---

# Worktree Cleanup

Facts come from a script; **decisions are yours**. The script (`scripts/worktree-audit.ts`, relative to this skill's repo root — i.e. `../../scripts/worktree-audit.ts` from this file) never deletes anything and never talks to `gh` beyond a single read-only `pr list`. It just emits JSON per worktree: branch, commit age, dirty/local-only-commit state, PR status, and whether the path is **actively in use** (any running process has it as cwd, detected via `lsof`).

## Step 1 — Run the audit

```bash
npm_config_registry=https://registry.npmjs.org npx -y tsx <path-to>/scripts/worktree-audit.ts --repo <repo-root>
```

- Run from anywhere inside the target repo (main checkout or any worktree) — `--repo` just needs to resolve to something inside it.
- Omit `--repo` to default to cwd.
- The `npm_config_registry=...` prefix works around Hopper's GAR 403 on `npx` package resolution (see global AGENTS.md); drop it if not needed in this environment.
- Add `--format table` for a quick human read while iterating; the skill itself should consume the default JSON.
- `--stale-days N` (default 14) controls the no-PR staleness threshold.

Check `warnings` in the JSON output first — e.g. `gh pr list` failed (no auth/network) or `lsof` unavailable means PR status / in-use detection is degraded. Say so before proceeding.

## Step 2 — Classify, don't just relay `suggestion`

The script's `suggestion` field is a hint, not a verdict. Group worktrees by it and sanity-check before presenting:

| suggestion | meaning | your job |
|---|---|---|
| `keep_main` | primary repo checkout | skip, never touch |
| `in_use` | a live process has this path (or a subdir) as cwd | **hard skip, always** — never offer deletion even if PR merged. Report separately as "in use, revisit later" |
| `prune` | worktree dir is gone but git metadata remains | safe to `git worktree prune`; branch may still be worth keeping/deleting separately |
| `safe_delete` | PR merged, clean, no local-only commits | default: batch-propose these together |
| `review_merged_has_work` | PR merged but dirty tree or local-only commits | PR merged so the *reviewed* content landed, but there's uncommitted/unpushed stuff on top — show a diff/log before offering to discard |
| `review_pr_closed` | PR closed without merging, clean | likely abandoned — confirm before deleting, don't assume |
| `review_closed_has_work` | PR closed without merging, has local-only work | most cases needing real judgment — show what's there |
| `keep_pr_open` | PR open | keep; optionally note if stale/needs-rebase, but don't offer deletion |
| `review_no_pr_has_work` | no PR, has uncommitted/unpushed commits | never mine, only rescue-or-discard candidates |
| `review_stale_no_pr` | no PR, no local work, no activity past stale-days | likely a dead experiment — confirm before deleting |
| `review_recent_no_pr` | no PR, no local work, recent activity | probably still WIP — ask, don't push for deletion |

## Step 3 — Present a batch plan, not 20 questions

Summarize counts per category, then:
- **`safe_delete`**: list them, propose deleting worktree + branch together in one batch confirm. This is the only class safe to bulk-confirm.
- **`prune`**: mention separately — `git worktree prune` handles these regardless of branch decision; ask about the branch too (it usually still exists and needs its own call on merged/unmerged).
- Everything else (`review_*`, `keep_pr_open`, `in_use`): walk through briefly, one line each, and only go deeper (show diff/log) if the user wants to look or if you're unsure.

Never propose deleting anything with `localOnlyCommits > 0` or `dirty: true` without showing what's there first — these are the only copies of that work.

## Step 4 — Execute

Per confirmed item, from the **main repo root** (not from inside the worktree being removed):

```bash
git worktree remove <path>            # add --force only if dirty and user explicitly accepted losing changes
git branch -D <branch>                # only if deleting the branch too; skip for keep-branch cases
git worktree prune                    # sweep any remaining prunable entries in one pass
```

- If `git worktree remove` fails because the tree is dirty, don't silently `--force` — surface the diff and re-confirm.
- For local-only commits worth rescuing before delete: `git push -u origin <branch>` to back it up, or `git log -p <branch> ^origin/master > ~/graveyard/<branch>.patch` if the user doesn't want it on the remote at all. Ask which they prefer; don't assume.
- Re-run the audit after cleanup to confirm the target state, especially after a batch.

## Notes / known limits

- `in_use` detection is `lsof`-based and per-path-prefix; it catches any shell/editor/agent sitting in the directory regardless of tool (cmux, plain terminal, etc.), but can't see e.g. an SSH session on another machine touching the same NFS-mounted path. Good enough for local dev.
- `localOnlyCommits` is a best-effort proxy: if no upstream is configured, it falls back to "commits ahead of the default branch" since there's no tracking ref to diff against. This means it can't distinguish "never pushed" from "pushed to a differently-named remote branch" — if in doubt, check `git branch -vv` for that branch before treating it as unpushed.
- The audit script has no side effects and is safe to re-run freely.
