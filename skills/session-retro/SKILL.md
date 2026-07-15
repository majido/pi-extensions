---
name: session-retro
description: Produce a structured, evidence-cited retrospective of the current session. Use when asked to "retro this session", "write a retrospective", "session retro", or when /branch-done runs its end-of-session retro.
---

Produce a structured retrospective of this session. Be direct, skip praise, cite evidence.

For every finding, quote the specific turn (`> "..."`) and give a concrete next-time action.

## Dimensions (omit any with no issues)

- **Skill & tool selection** — missed skill loads, wrong tool, sequential calls that should have been parallel, unnecessary bash vs. dedicated tools.
- **Assistant performance** — wrong assumptions, hallucinated paths/APIs, premature edits, insufficient verification, over-engineering.
- **Prompt quality** — ambiguity, missing context, missing file refs, missing constraints.
- **Task scoping** — chunks too large/vague, missed batching opportunities.
- **Back-and-forth** — avoidable clarification loops, corrections that signal ambiguous original ask.
- **Verification** — missing test/build steps, re-do cycles from weak review.
- **Agent sandbox or permission friction** — tasks or tool calls blocked by lacking permission, API calls that failed due to insufficient permissions, and steps taken (or missed) to resolve them.
- **Rules to add/update** — recurring patterns worth codifying in project or global AGENTS.md.

## End with

- **Top 3 wins for next session** — ranked, highest-leverage first.
- **Persist** — write the retro content to the file path provided in the request.

## File naming

Retros are stored under `~/.agents/retros/` using the format:

```
~/.agents/retros/<YYYY-MM-DD>-<slug>.md
```

- `<YYYY-MM-DD>` is today's date (`date +%F`).
- `<slug>` is a short kebab-case identifier — when invoked from `/branch-done`,
  it is the sanitized branch name (truncated to 40 chars); otherwise a short
  hyphenated slug describing the session.

When a caller (e.g. `/branch-done`) supplies an explicit "Write the retro to:
`<path>`" instruction, honor that exact path. Otherwise derive the path from the
format above.
