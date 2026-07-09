# pi-extensions

Personal [pi](https://pi.dev) extensions, skills, prompts, and themes.

## Install

```bash
pi install https://github.com/majido/pi-extensions
```

## Extensions

### branch-worktree

Creates a git worktree from a base branch and opens it in a sibling [cmux](https://github.com/nicholasgasior/cmux) workspace.

```
/branch <name> [--base ref] [--worktree-dir dir] [--command cmd]
/branch-done [--no-retro] [--keep-branch]
/worktree-status
```

Auto-detects `origin/main` or `origin/master` as the base. Override with `--base` or the `PI_BRANCH_BASE` env var. `/branch-done` runs a session retro (written to `~/.agents/retros/`), then removes the worktree, deletes the branch, and closes the cmux workspace once the retro finishes.

| Env var | Default | Description |
|---------|---------|-------------|
| `PI_BRANCH_BASE` | auto-detect | Base branch for new worktrees |
| `PI_BRANCH_WORKTREE_DIR` | `.worktree` | Directory for worktrees relative to repo root |
| `PI_BRANCH_AGENT_COMMAND` | `exec pi` | Command to run in the new cmux workspace |

### custom-footer

Replaces the default footer with a compact, single-line layout: repo/branch with git indicators on the left, context usage, cost, and model on the right.

![custom-footer](docs/screenshots/custom-footer.png)

```
iris ⑂ fix-mcp-schema-sanitization        62%▕██████▎░░░ $0.42 fable-5 ♞
```

- **Git indicators**: `*` dirty, `⇣`/`⇡` behind/ahead, `⑂` worktree separator (`|` for regular checkouts). Branch resolved per-worktree.
- **Context bar**: eighth-block resolution (`▏▎▍▌▋▊▉█`) over a `░` track, with a color gradient from success → warning → error as context fills.
- **Thinking level**: chess glyphs, ascending by rank — ♙ minimal · ♟ low · ♞ medium · ♛ high · ♚ max.
- **Responsive**: on narrow terminals, segments hide progressively — bar, repo, cost, branch, model, then context % — and the right block stays right-aligned.
- **MCP status** is inlined (`· MCP 2/6`) when servers are connected; other extension statuses render on a second line.

Tests: `npm test` (layout logic is exported as pure functions, covered by `extensions/custom-footer.test.ts`).

### compact-bash

Overrides the built-in `bash` tool's result renderer to save vertical space: compact durations (`0.6s`), `no output` inlined with the duration, one less trailing line. Execution, streaming, and truncation are inherited from the built-in tool.

### answer

`/answer [guidance]` extracts questions from the last assistant message and presents an interactive TUI to answer them one by one. From [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff).

### pr-sitter-status

Status widget below the editor showing the active PR sitter (see the `pr-sitter` prompts):

```
PR Sitter: #39 iris • watching • next check in 3m (last one 43s ago)
```

Display-only; reads state from `~/.cache/pr-sitter/`, refreshes every 30s.

### vertex-claude

Registers Google Cloud Vertex AI as a provider for Claude models using the Anthropic Vertex SDK.

| Env var | Default | Description |
|---------|---------|-------------|
| `GOOGLE_CLOUD_PROJECT` | *(required)* | GCP project ID |
| `GOOGLE_CLOUD_VERTEX_LOCATION` | `us-east5` | GCP region for Vertex AI |

Requires GCP application default credentials (`gcloud auth application-default login`). Models that are only served on the `global` Vertex endpoint are routed there automatically.

Registered model IDs:

- `vertex-claude/claude-fable-5`
- `vertex-claude/claude-opus-4-8`
- `vertex-claude/claude-opus-4-7`
- `vertex-claude/claude-opus-4-6`
- `vertex-claude/claude-opus-4-5`
- `vertex-claude/claude-opus-4-1`
- `vertex-claude/claude-opus-4`
- `vertex-claude/claude-sonnet-5`
- `vertex-claude/claude-sonnet-4-6`
- `vertex-claude/claude-sonnet-4-5`
- `vertex-claude/claude-sonnet-4`
- `vertex-claude/claude-haiku-4-5`
- `vertex-claude/claude-3-5-haiku@20241022`

## Prompts

### pr-sitter

`/pr-sitter [stop|status|focus]` cleans up the working tree, commits, opens a draft PR, then babysits CI and reviews with exponentially backed-off monitor cycles (`pr-sitter-monitor` runs each cycle via scheduled prompts). Straightforward fixes are pushed as new commits; anything ambiguous is escalated.

## Skills

- **commit** — Conventional Commits guidance; read before making git commits.
- **skillify** — turn a repeatable workflow from the current session into a reusable skill draft.

## Structure

```
extensions/    → pi extensions (.ts) + tests (*.test.ts, excluded from loading)
skills/        → agent skills (SKILL.md folders)
prompts/       → prompt templates (.md)
themes/        → themes (.json)
docs/          → screenshots and docs
```
