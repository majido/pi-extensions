---
name: session-retro-act
description: Analyze unprocessed session retrospectives, identify recurring workflow improvements, present ranked proposals for review through Lavish, implement only explicitly approved changes, and update the durable workflow summary. This skill should be used for periodic retrospective processing, such as daily or weekly workflow improvement reviews.
---

# Session Retro Act

Turn recent session retrospectives into durable workflow improvements.

Operate in two distinct phases:

1. **Analyze and propose** — read-only; make no workflow mutations.
2. **Act on approval** — implement only proposals explicitly approved by the user.

Never install tools, edit skills or extensions, change settings, or update the workflow summary before approval.

## Files

- Workflow summary: `~/.agents/current-workflow.md`
- Retrospectives: `~/.agents/retros/*.md`
- Processing state: `~/.agents/retro-act/state.json`
- Reports: `~/.agents/retro-act/reports/<YYYY-MM-DD>-<HHMMSS>.html`

Create the state and report directories when needed.

## Processing state

Use content hashes rather than filenames alone. Track each retrospective using:

- Path
- SHA-256 hash
- First analyzed timestamp
- Most recent report
- Status: `analyzed`, `approved`, `partially-approved`, `rejected`, or `applied`
- Decisions and resulting changes

Treat a retrospective as unprocessed when:

- Its path is absent from the state file, or
- Its current content hash differs from the recorded hash.

Do not reanalyze unchanged retrospectives already marked `analyzed`. Surface their outstanding decisions as pending instead.

Mark a retrospective `analyzed` only after generating its report successfully. Mark it `applied` only after implementing and validating approved changes.

If no retrospectives are unprocessed, report that briefly and point to any pending decisions. Do not generate a redundant report.

## 1. Prime the context

Read `~/.agents/current-workflow.md` completely before analyzing retrospectives.

Treat it as the current baseline, not unquestionable truth. Extract:

- Current tools, skills, extensions, MCPs, prompts, and agents
- Existing automation and scheduled workflows
- Known operating rules and approval boundaries
- Recurring repositories and task types
- Existing pain points or planned improvements

If the file is missing, stop and ask whether to create an initial workflow summary. Do not infer and persist one automatically.

## 2. Select retrospectives

Discover unprocessed retrospectives under `~/.agents/retros/`.

Process at most 10 per run, oldest first. If more remain, report the backlog count for the next run.

Do not interpret an old retrospective as evidence of a current problem without checking whether the workflow has already changed since it was written.

## 3. Analyze with subagents

Use one fresh-context, read-only subagent per selected retrospective, with a maximum concurrency of 4.

Before launching subagents, inspect the configured agents and use only executable, non-disabled read-only agents. Keep all output inline or under a scratch/report directory; never write child output into a project root.

Subagents must not:

- Modify files
- Install tools
- Spawn additional subagents
- Post comments or publish artifacts
- Treat unsupported retrospective claims as verified facts

Give each subagent:

- The retrospective path
- A concise summary of the current workflow
- The required structured output below

Require each result to contain:

1. **Validated observations**
   - What happened
   - Supporting quotation or evidence
   - Whether the original session evidence was available
   - Confidence: high, medium, or low

2. **Root causes**
   - Workflow gap, missing automation, prompt issue, tool misuse, knowledge gap, or isolated mistake
   - Whether the issue appears recurring or one-off

3. **Candidate improvements**
   - Modify an existing skill, extension, prompt, agent, MCP, setting, or rule
   - Create something new only when modification is insufficient
   - Prefer deterministic automation for repetitive, stable procedures
   - Identify the likely source-of-truth file or repository
   - Include expected benefit, effort, risk, and validation method

4. **Ideas to reject**
   - Suggestions that are speculative, duplicative, overly broad, obsolete, or not worth their maintenance cost

When source session metadata is available in the retrospective, use it to locate the original session evidence. Otherwise label factual validation as limited; do not imply that the retrospective itself independently proves its claims.

For a run that must return a report before ending, wait for the bounded fanout through the harness-native subagent completion mechanism. Never sleep or poll status in a loop.

## 4. Validate proposals against the current system

Before recommending a change, inspect the actual relevant skill, extension, prompt, agent, MCP configuration, or rules file.

Confirm:

- The proposed capability does not already exist
- The referenced path is the source of truth, not an installed or generated copy
- The recommendation follows current Pi and project conventions
- A smaller change to an existing mechanism would not solve the problem
- The expected benefit justifies ongoing maintenance

Prefer, in order:

1. Use an existing capability correctly
2. Modify an existing prompt or rule
3. Modify an existing skill or extension
4. Add lightweight automation
5. Adopt an external tool or MCP
6. Create a new skill or extension

Do not recommend novelty for its own sake.

## 5. Synthesize and rank

Collate subagent findings by root cause rather than by retrospective.

Deduplicate overlapping suggestions and identify recurring patterns across sessions.

Rank up to 10 proposals using:

- Expected workflow impact
- Frequency of the underlying problem
- Evidence confidence
- Implementation effort
- Operational and maintenance cost
- Reversibility
- Risk of unintended behavior

Do not pad the list. Zero proposals is valid.

For every proposal include:

- Title and rank
- Problem and root cause
- Retrospectives providing evidence
- Confidence
- Proposed change
- Exact likely targets
- Why this is preferable to alternatives
- Expected benefit
- Effort and risk
- Validation and rollback plan
- Recommended disposition: approve, experiment, defer, or reject

Separate durable workflow improvements from isolated session mistakes that need no system change.

## 6. Present the report with Lavish

Load and follow the `lavish` skill. Use its `plan`, `comparison`, and `input` playbooks before writing the report.

Create a single-page HTML report containing:

- Run summary and processed retrospective count
- Current workflow baseline
- Recurring patterns
- Ranked proposal cards
- Evidence and confidence
- Cost, risk, and impact comparison
- Proposed files or systems affected
- Approval controls for each proposal:
  - Approve
  - Approve with changes
  - Experiment
  - Defer
  - Reject
- Free-form feedback
- Processing backlog and unresolved decisions

Open the report with `lavish-axi` and poll for feedback according to the Lavish workflow during an interactive run.

For an unattended or scheduled run, do not block indefinitely waiting for browser feedback. Poll only through a foreground interaction or a harness-native tracked job with a verified wake path. Otherwise return the local report path and leave decisions pending for a later interactive invocation.

Keep the report local. Do not publish or share it externally unless explicitly requested. Redact secrets, tokens, PII, and sensitive operational output.

## 7. Approval gate

Treat only explicit user selections or written feedback as approval.

Before implementation, summarize:

- Approved proposals
- Requested modifications
- Deferred or rejected proposals
- Files and repositories expected to change
- Whether commits or pushes were authorized

Ask for clarification when approval is ambiguous. Silence is not approval.

## 8. Implement approved changes

Apply only approved changes.

Use a single writer for each working tree. Read the relevant specialist skill before modifying skills, extensions, prompts, or Pi configuration.

For each change:

1. Inspect repository status and preserve unrelated work.
2. Confirm the source-of-truth location.
3. Make the smallest change that achieves the approved outcome.
4. Add or update focused tests where behavior changes.
5. Validate using the repository's required commands.
6. Record failures, limitations, and rollback instructions.
7. Do not commit or push unless that was explicitly approved.

Do not automatically install external tools, enable MCP servers, create scheduled jobs, or alter credentials without separate explicit approval.

## 9. Update the workflow summary

After approved changes pass validation, update `~/.agents/current-workflow.md`.

Keep it concise and current. Record:

- The resulting workflow, not the full retrospective history
- New or changed skills, extensions, prompts, MCPs, agents, and automation
- When and why they should be used
- Approval or safety boundaries
- Known limitations
- Deferred experiments still worth tracking
- Date of the update

Do not record rejected ideas as part of the active workflow.

## 10. Finalize state

Update `~/.agents/retro-act/state.json` atomically.

For every processed retrospective, record:

- Content hash
- Report path
- User decision
- Applied changes
- Validation result
- Final status

If implementation fails, retain the decision but do not mark the retrospective `applied`. Record the failure and leave it eligible for follow-up without rerunning the original analysis.

Finish with:

- Retrospectives processed
- Changes applied
- Validation performed
- Workflow summary updated
- Deferred or failed work
- Remaining unprocessed backlog
- Commit and push status
