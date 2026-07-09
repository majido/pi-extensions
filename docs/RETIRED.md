# Retired Skills

Personal skills retired in favor of adopted [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
equivalents (ao adoption Phase 1). Retired skill directories were moved (plain `mv` —
`~/.agents/skills` is not a git repo) out of the skills tree into
`~/.agents/retired-skills/`. (An `_retired/` subdir inside `~/.agents/skills` does NOT
work — pi discovers `SKILL.md` directories recursively regardless of prefix.)
`~/.pi/agent/skills` is a symlink to `~/.agents/skills`, so this covers both paths.

## Retired

| ao replacement skill | Retired skill | Old path | New path | Rollback |
|---|---|---|---|---|
| planning-and-task-breakdown | writing-plans | `~/.agents/skills/writing-plans` | `~/.agents/retired-skills/writing-plans` | `mv ~/.agents/retired-skills/writing-plans ~/.agents/skills/writing-plans` |
| incremental-implementation | executing-plans | `~/.agents/skills/personal/executing-plans` | `~/.agents/retired-skills/personal/executing-plans` | `mv ~/.agents/retired-skills/personal/executing-plans ~/.agents/skills/personal/executing-plans` |
| code-simplification | code-refactoring | `~/.agents/skills/code-refactoring` | `~/.agents/retired-skills/code-refactoring` | `mv ~/.agents/retired-skills/code-refactoring ~/.agents/skills/code-refactoring` |
| code-review-and-quality | review-plans | `~/.agents/skills/review-plans` | `~/.agents/retired-skills/review-plans` | `mv ~/.agents/retired-skills/review-plans ~/.agents/skills/review-plans` |

## Flagged, NOT retired (reassess in later phases)

Partial overlap only — kept in place:

- `python-testing-patterns`, `python-test-reviewer` — Python-specific; adopted TDD skill is generic
- `user-story-splitting` — product/story splitting, not engineering task breakdown
- `personal/scala-architecture-review` — Scala-specific
- subagent `verifier` — read-only reporting, different role from `/test`
