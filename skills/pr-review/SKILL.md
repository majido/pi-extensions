---
name: pr-review
description: Review a GitHub PR assigned to me end-to-end — gather context, verify author claims empirically, judge the code via the code-review-and-quality skill, then stop and ask the user before posting anything. Use when asked to review a PR, when /review-pr runs, or when a pr-review-inbox workspace starts.
---

# PR Review

Review a PR on the user's behalf. The user is the reviewer of record; you prepare
the review and **never post, approve, or request changes without their explicit
confirmation**.

## Setup

You are usually launched in a treehouse worktree already checked out at the PR
head, with the PR URL in the kickoff message. Confirm with `git log -1` and
`gh pr view <n>`.

If not in a checkout, review from the diff alone and say so in the verdict.

## Step 1 — Gather context

```bash
gh pr view <n> --repo <owner/repo> --json title,body,author,baseRefName,files,additions,deletions
gh pr diff <n> --repo <owner/repo>
```

Fetch existing review threads (resolved ones too — they carry decisions):

```bash
gh api graphql -f query='query { repository(owner: "<owner>", name: "<repo>") {
  pullRequest(number: <n>) { reviewThreads(first: 50) { nodes {
    isResolved path line comments(first: 10) { nodes { author { login } body } }
  } } } } }'
gh api repos/<owner>/<repo>/issues/<n>/comments --jq '[.[] | {user: .user.login, body: .body}]'
```

Note:
- Claims the PR description makes (e.g. "this is a no-op for X", "library Y
  handles Z") — these need verification, not trust.
- Open questions from other reviewers, and whether the author answered them.
- Linked tickets; read them if the PR intent is unclear.

## Step 2 — Verify claims empirically

Do not take the PR description's word for behavioral claims. The worktree has
the project venv/toolchain — use it:

- Library behavior claims → read the actual installed library source
  (`.venv/lib/.../<pkg>`) and/or run a small live check with `uv run python -c`.
- "Tests cover this" → run the touched tests.
- "No-op for path X" → trace path X in the code and confirm.

Cheap local checks when the project makes them easy (e.g. for iris:
`uv run ruff check src/ tests/`, `uv run pyright src/`, targeted `uv run pytest`).
Skip expensive suites; say what you skipped.

## Step 3 — Judge the code

Apply the `code-review-and-quality` skill (five axes: correctness, readability,
architecture, security, performance) to the diff. Its approval standard applies:
approve what definitely improves code health, don't block on taste.

For bot PRs (renovate, drift automation, dependency bumps): skip deep review;
check the changelog/diff of the bumped dependency for breaking changes and CI
status, then recommend rubber-stamp or flag.

## Step 4 — Verdict, then stop and ask

Present a structured verdict:

```markdown
## Review: <repo>#<n> — <title>

**Recommendation**: approve / approve-with-nits / request-changes / needs-discussion

### Blocking
- <file:line> — <issue and why it blocks>

### Questions
- <things to ask the author>

### Nits
- <non-blocking suggestions>

### Verified
- <claim> → <how verified, result>

### Skipped
- <what wasn't checked and why>
```

Then **stop** and ask the user what to do next. Offer:

1. Post inline comments and/or the review (approve / comment / request changes)
2. Edit the drafts first
3. Discard — user handles it in the GitHub UI
4. Dig deeper into something

After the selected action is complete, ask explicitly:

> Should I consider this review done and clean up the review workspace?

If the user confirms, invoke `/review-done` automatically. Do not merely remind
them to run it. Review cleanup must not run a session retro; `/review-done` only
returns the review worktree and closes the review workspace. If they decline,
leave the review workspace open.

## Step 5 — Posting (only after confirmation)

Every comment you post must start with the agent attribution prefix:

```
🤖 **<Model>**: <comment>
```

Use a short model name (`Claude`, `GPT`, `Gemini`); fall back to
`$PI_AUTHOR_MODEL`.

- Inline comments: `gh api repos/<owner>/<repo>/pulls/<n>/comments` with
  `commit_id`, `path`, `line` (or reply with `in_reply_to`).
- Review: `gh pr review <n> --repo <owner/repo> --approve|--comment|--request-changes --body "..."`.

Show each comment body to the user before sending unless they already approved
the exact drafts.

## Step 6 — Wrap up

The review is not complete until the user has either declined cleanup or
confirmed that it is done and `/review-done` has been invoked. `/review-done`
returns the worktree and closes the review workspace; do not run a session retro
as part of review cleanup.
