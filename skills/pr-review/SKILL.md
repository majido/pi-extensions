---
name: pr-review
description: "Review a GitHub PR assigned to me end-to-end — gather context, verify author claims empirically, judge the code via the code-review-and-quality skill, then stop and ask the user before posting anything (inbox pickups run in auto-post mode: they post the first round of comments themselves but never approve). Use when asked to review a PR, when /review-pr runs, or when a pr-review-inbox workspace starts."
---

# PR Review

Review a PR on the user's behalf. The user is the reviewer of record; you prepare
the review and **never post, approve, or request changes without their explicit
confirmation**, except in auto-post mode (below).

## Auto-post mode

The kickoff says "Auto-post mode" when the review inbox picked up the PR. In this mode:

- After Step 4's verdict, skip the menu and post the first round straight away
  (Step 5): one inline comment for each anchored finding (blocking issues,
  questions, nits), then one summary review.
- Submit the summary with `--comment` only. **Never `--approve`**, and don't
  `--request-changes` either: the user decides the review state. Put the
  recommendation in the summary body.
- Only the first round is automatic. After posting, list what you posted
  (with links) and follow Step 4's menu for anything further. Replies, follow-up
  rounds, approval and changing the review state all need confirmation again.
- If nothing is worth commenting on, post nothing and say the PR looks ready
  for the user to approve.
- After posting, schedule the follow-up check (Step 5b).

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
- Claims made by other reviewers in the thread (not just the PR description)
  — verify those against source too before relaying or endorsing them in your
  verdict.

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
- <file:line — or "general" if it has no line> — <thing to ask the author>

### Nits
- <file:line> — <non-blocking suggestion>

### Verified
- <claim> → <how verified, result>

### Skipped
- <what wasn't checked and why>
```

Anchor every finding to `file:line` wherever one exists — that is what makes it
postable as an inline comment in Step 5. Only a finding about the change as a
whole (scope, missing ticket, overall design) stays unanchored.

Then **stop** and ask the user what to do next. Offer:

1. Post the review (approve / comment / request changes) with inline comments
   on each anchored finding (Recommended)
2. Post the summary review only, no inline comments
3. Edit the drafts first
4. Discard — user handles it in the GitHub UI
5. Dig deeper into something

**Discard (4) is itself a wrap-up decision**: the user is taking the PR over in
the GitHub UI, so the review workspace has no further purpose. Say nothing was
posted and invoke `/review-done` immediately — do **not** ask the cleanup
question.

After any other selected action is complete, ask explicitly:

> Should I consider this review done and clean up the review workspace?

If the user confirms, invoke `/review-done` automatically. Do not merely remind
them to run it. Review cleanup must not run a session retro; `/review-done` only
returns the review worktree and closes the review workspace. If they decline,
leave the review workspace open.

If the user states unprompted that the review is done (e.g. "review is done",
"done", "clean up") — with or without this question having been asked — treat
that as confirmation and invoke `/review-done` immediately. Do not ask the
confirming question back to them in that case; only ask it when you are the
one proposing to wrap up.

## Step 5 — Posting (only after confirmation)

Every comment you post (inline comments, replies, review summary) must start
with the attribution prefix from "Comment Attribution" in AGENTS.md:

```
⁂ by <Model>: <comment>
```

Use a short model name (`Claude`, `GPT`, `Gemini`); fall back to
`$PI_AUTHOR_MODEL`.

**Prefer inline comments.** A finding that names a line belongs on that line, not
buried in the summary body: the author sees it in the diff, GitHub threads the
reply, and it resolves with the code. Post one inline comment per anchored
finding — blocking issues, questions, and nits alike — and keep the review body
for the recommendation, cross-cutting points, and what you verified/skipped.
Don't restate each inline comment in the body; point at them instead.

- Inline comments: `gh api repos/<owner>/<repo>/pulls/<n>/comments` with
  `commit_id` (PR head sha from `gh pr view <n> --json headRefOid`), `path`,
  `line`, `side=RIGHT` (or reply with `in_reply_to`).
  - `line` must be a line the diff touches on that side; for a deleted line use
    `side=LEFT`, and for a range add `start_line`.
  - A finding about an unchanged line is still worth inline placement: anchor it
    to the nearest touched line and say which line you mean.
  - Batch them in one bash call (a small shell function over `gh api`), then post
    the review last so the author gets one notification set.
- Review: `gh pr review <n> --repo <owner/repo> --approve|--comment|--request-changes --body "..."`.

Show each comment body to the user before sending unless they already approved
the exact drafts or this is auto-post mode's first round.

## Step 5b — Schedule the follow-up check

Once review comments are posted (in any mode), schedule a recurring check every
4 hours in this session:

```
schedule_prompt action=add type=interval schedule=4h
  name=pr-review-followup-<repo>-<n>
  description="Follow-up check for <repo>#<n>"
  prompt="Follow-up check for <PR url>: run the pr-review skill's 'Follow-up check' section."
```

The name must start with `pr-review-followup-`: `/review-done` uses that prefix
to stop the job if the session does not. Schedule it once per review. If one
already exists, leave it. Note the PR head sha you reviewed; the check compares
against it.

## Follow-up check

Runs when the scheduled prompt fires. Read-only: post, approve, or change review
state only after the user confirms.

1. **PR closed or merged?** Stop the follow-up job (`schedule_prompt
   action=remove`), say so, and offer cleanup (Step 6).
2. **Anything new?** Compare against the last reviewed or checked state:
   - New commits: `gh pr view <n> --json headRefOid,commits`, then
     `git fetch` and `git diff <last-sha>..<head>` in the worktree.
   - Responses on your threads: the review threads query from Step 1 (replies,
     resolved state) plus new PR conversation comments.
   - If nothing changed, reply in one line (`No updates on <repo>#<n> since <time>;
     next check in 4h.`) and stop.
3. **Evaluate each comment you posted:**

   | Comment | Status | Evidence |
   |---|---|---|
   | `<file:line> — <summary>` | addressed / partly addressed / not addressed / author disagrees / answered | `<commit/diff hunk or reply>` |

   Check the code itself, not just the reply. "Done" without a matching diff is
   *not addressed*. For a disagreement, judge whether the author's argument
   holds.
4. **Look over the new changes** (the diff since your last sha), not only the
   parts tied to comments. Flag new problems the commits introduced.
5. **Suggest next steps.** Pick one and give the reason:
   - **Approve**: every blocking comment is addressed and nothing new is blocking.
   - **Approve with nits**: only optional points remain.
   - **Reply on threads**: draft responses (pushback, follow-up questions, acks).
   - **Full re-review**: the new diff is large or changes the design, so a
     delta review is not enough.
   - **Request changes**: blocking comments ignored or wrongly dismissed.
   - **Wait**: the author is still working (partial push, open "will fix"
     replies).
6. Draft any replies or review text and **stop and ask**, as in Step 4. Record
   the new head sha as the last checked state. Keep the follow-up job running
   unless the user approves, requests changes as final, or ends the review.

## Step 6 — Wrap up

**Stop the follow-up job before cleanup.** Run `schedule_prompt action=list`,
then `action=remove` for this review's `pr-review-followup-*` job, *before*
invoking `/review-done` (and in the Discard path). `/review-done` also removes
it from the worktree as a safety net.

The review is not complete until the user has either declined cleanup or
confirmed that it is done and `/review-done` has been invoked. `/review-done`
returns the worktree and closes the review workspace; do not run a session retro
as part of review cleanup.
