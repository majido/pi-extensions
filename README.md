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
```

Auto-detects `origin/main` or `origin/master` as the base. Override with `--base` or the `PI_BRANCH_BASE` env var.

| Env var | Default | Description |
|---------|---------|-------------|
| `PI_BRANCH_BASE` | auto-detect | Base branch for new worktrees |
| `PI_BRANCH_WORKTREE_DIR` | `.worktree` | Directory for worktrees relative to repo root |
| `PI_BRANCH_AGENT_COMMAND` | `exec pi` | Command to run in the new cmux workspace |

### vertex-claude

Registers Google Cloud Vertex AI as a provider for Claude models using the Anthropic Vertex SDK.

| Env var | Default | Description |
|---------|---------|-------------|
| `GOOGLE_CLOUD_PROJECT` | *(required)* | GCP project ID |
| `GOOGLE_CLOUD_VERTEX_LOCATION` | `us-east5` | GCP region for Vertex AI |

Requires GCP application default credentials (`gcloud auth application-default login`).

Registered model IDs:

- `vertex-claude/claude-opus-4-8`
- `vertex-claude/claude-opus-4-7`
- `vertex-claude/claude-opus-4-6`
- `vertex-claude/claude-sonnet-4-8`
- `vertex-claude/claude-sonnet-4-7`
- `vertex-claude/claude-sonnet-4-6`
- `vertex-claude/claude-haiku-4-6`
- `vertex-claude/claude-haiku-4-5@20251001`

## Structure

```
extensions/    → pi extensions (.ts)
skills/        → agent skills (SKILL.md folders)
prompts/       → prompt templates (.md)
themes/        → themes (.json)
```
