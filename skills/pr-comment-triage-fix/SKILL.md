---
name: pr-comment-triage-fix
description: Triage review comments on your own pull request and address the clear wins while escalating design-level ones. Use when your PR gets review feedback, when watching a PR for new comments, or when asked to "address review comments", "respond to feedback", or "handle the PR review". Auto-applies low-risk requests with an attributed reply; escalates architectural disagreements.
---

# PR Comment Triage & Fix

Given review activity on a pull request **you authored**, decide for each
comment whether to apply it now (clear win) or escalate it (design-level), then
act. Keep changes minimal and validated.

## Inputs you need

- `repo` (`owner/repo`) and PR number.
- Your GitHub login (`gh api user --jq '.login'`) — ignore comments you authored.
- The branch you own and may push to. **Only push to branches you own**; never
  force-push, never auto-merge.

## 1. Fetch review activity

```bash
gh api repos/<repo>/pulls/<pr>/comments     # inline review comments (has id, path, line)
gh api repos/<repo>/issues/<pr>/comments    # conversation comments (has id)
gh api repos/<repo>/pulls/<pr>/reviews      # review submissions (has id, state, body)
gh pr view <pr> -R <repo> --json reviewDecision,url
```

## 2. Dedup (when running in a monitor loop)

New activity = comment/review ids not in your recorded `seenCommentIds` /
`seenReviewIds`. Ignore anything authored by you. Reviews with no body and no
child comments are not actionable.

## 3. Classify each comment

**Clear win — apply autonomously:**

- Rename, comment/wording, small local refactor
- Obvious bug the reviewer spotted
- Doc tweak, typo, missing null/error guard
- Test the reviewer asked for that is clearly correct to add
- Style/lint nit not caught by CI

**Design-level — escalate, do not silently comply or override:**

- Architectural choice, API-shape disagreement, or a tradeoff call
- Scope expansion ("while you're here, also…")
- Anything you disagree with on technical merit
- Ambiguous requests where the intent isn't clear

Escalate by recording a `needsDecision` entry: the comment text, author,
file/line, and a one-line summary of the tradeoff (and your recommendation).
Do not reply on the user's behalf to design-level threads — leave those for the
human.

## 4. Apply, validate, reply

For each clear win:

1. Make the minimal change.
2. Validate with the project's build/test/lint.
3. Commit (new commit, Conventional Commit title, `commit` skill) and push.
4. Reply to the thread noting it's addressed. **Every reply MUST start with the
   agent attribution prefix** `🤖 **<Model>**: ` (use a short model name —
   `Claude`, `GPT`, `Gemini`). Example:
   `🤖 **Claude**: good catch — fixed in abc123.`

   Reply to an inline thread:
   ```bash
   gh api repos/<repo>/pulls/<pr>/comments/<comment-id>/replies \
     -f body='🤖 **Claude**: good catch — fixed in abc123.'
   ```

Never apply every suggestion blindly. Batch related fixes into coherent commits
rather than one commit per nit.

## 5. Report

One line per comment: author, what they asked, what you did (commit subject) or
that it's escalated. List `needsDecision` items separately.

## Red flags

- Replying without the `🤖 **<Model>**:` attribution prefix
- Auto-complying with a design-level request to avoid escalating
- Pushing fixes without local validation
- One noisy commit per trivial comment instead of batching
