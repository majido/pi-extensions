---
name: repo-wiki
description: "Bootstrap and maintain an llm-wiki style docs/wiki/ for a repository: scan the repo, fan out subagents for one-time page generation, link the wiki from README/AGENTS.md, and install path-scoped .claude/rules so future agent sessions keep the docs updated. Use when asked to 'bootstrap a repo wiki', 'generate repo documentation', 'set up docs/wiki', 'create an llm wiki', or 'auto-generate docs for this repo'."
---

# Repo Wiki

Create a durable, agent-maintained documentation wiki for a repository, then wire up
discovery and maintenance rules so it stays current without CI automation.

**Scope boundary — what the wiki is:** documentation of what the system *is* — architecture,
data flow, conventions, how to extend it — for human and agent readers. It is **not**:

- plans or task lists (`docs/plans/`)
- scratch/research notes (`docs/scratchpad/`)
- changelogs, ADR history, or design proposals (those may be *linked* from wiki pages)

## Architecture (3 pieces)

1. **`docs/wiki/`** — the content. `index.md` is the single map; topic pages are the depth.
2. **Discovery links** — README.md and AGENTS.md (and CLAUDE.md if present) point at
   `docs/wiki/index.md` with the instruction: *read the index, then open only the pages
   relevant to the task at hand*. This is the cross-agent mechanism (pi, Codex, Cline, humans).
3. **`.claude/rules/`** — Claude Code-specific precision layer. One unscoped rule with the
   global contract, plus small path-scoped rules (`paths` frontmatter, glob patterns) that
   activate only when work touches a mapped folder and point to the specific wiki page.

No CI backstop. Maintenance is enforced in-session (rules) and at review time (wiki diffs
appear in the same PR as the code change).

## Workflow

### Phase 1 — Scan and propose

1. Survey the repo: manifests (package.json / pyproject.toml / build files), README,
   existing docs, top-level directory structure, test layout, deployment config.
2. Propose a page list (typically 6–10 pages) cut along the repo's real seams, e.g.:
   `architecture`, `<domain-core>`, `frontend`, `storage`, `deployment`, `testing`,
   plus repo-specific pages. Every page must map to concrete source folders — if you
   can't name the folders a page covers, the page is wrong.
3. Note existing docs that already cover ground. Wiki pages **link** to them; never duplicate.
4. **Stop and confirm the page list with the user before generating.**

### Phase 2 — Skeleton and links

1. Create `docs/wiki/index.md` from [templates/index.md](templates/index.md): one line per
   page + the reader instruction.
2. Add a Documentation section to README.md (one or two lines linking the index).
3. Add the agent contract to AGENTS.md (and CLAUDE.md if the repo has one) using
   [templates/agents-md-snippet.md](templates/agents-md-snippet.md).

### Phase 3 — One-time generation (subagent fan-out)

1. Fan out one subagent per page (parallel). Each task gets:
   - the assigned page path as its `output` (distinct files, so parallel writers don't collide)
   - the page's scope: which folders/files it covers, which sibling pages exist (so it can
     defer instead of overlap), links to existing docs it should reference
   - the quality bar (below)
2. **Parent does a synthesis pass** — this is not optional: fix cross-links, remove overlap
   between pages, verify every cited file path exists, finalize `index.md` summaries.

**Page quality bar** (put this verbatim in each subagent task):
- < 200 lines; link out rather than inline detail
- cite real file paths for every major claim
- cross-link sibling wiki pages where topics touch
- describe what IS, not history or future plans
- end with footer: `_Last verified: <YYYY-MM-DD> against <short-sha>_`

### Phase 4 — Install rules

1. Create `.claude/rules/wiki.md` (unscoped, always loaded) from
   [templates/rule-wiki.md](templates/rule-wiki.md).
2. Create one path-scoped rule per folder↔page mapping from
   [templates/rule-scoped.md](templates/rule-scoped.md). Keep each rule ≤ 6 lines:
   a pointer plus the update obligation. **All content lives in the wiki** — facts
   duplicated into rules go stale.
3. If the repo uses Cline, mirror the unscoped rule into `.clinerules/` (path scoping is
   Claude Code-only; other agents rely on the index).

### Phase 5 — Verify

- Every wiki page is linked from `index.md` (the discoverability invariant: a doc not
  reachable from an entry point is invisible).
- Every `paths` glob in `.claude/rules/` matches at least one real file.
- Every file path cited in wiki pages exists.
- README and AGENTS.md links resolve.

## The maintenance contract (encoded in rules + AGENTS.md)

Future sessions must, before finishing a change:

1. **Diff-scoped check** — does *your diff* invalidate any wiki page mapped to files you
   touched? Decide from the diff, not from vibes.
2. **Exit early when nothing is needed** — cosmetic changes, test-only changes,
   internal refactors with no architectural or interface impact ⇒ no wiki update. Say so
   and move on; doc churn is a failure mode too.
3. **Surgical edits only** — update the specific stale sections; never regenerate a page;
   match existing style; refresh the `Last verified` footer.
4. **Discoverability invariant** — a new wiki page must be linked from `index.md` in the
   same commit.
5. Wiki updates ship **in the same PR** as the code change.

## Pitfalls

- **Fat rules files** — rules that inline architecture facts diverge from the wiki. Rules
  point; wiki holds content.
- **Pages without owners** — a page not mapped to folders via a scoped rule will silently
  rot; if no glob fits, fold it into another page.
- **Duplicating existing docs** — link to design docs/READMEs instead of restating them.
- **Skipping the synthesis pass** — parallel subagents produce overlapping/contradictory
  pages; the parent must reconcile.
- **Wiki as changelog** — reject "we changed X to Y" phrasing; the wiki states the current truth.

## Success criteria

- A new agent session can read `index.md` + one page and correctly orient for a task in
  that area without scanning the whole repo.
- A code change touching a mapped folder triggers the corresponding rule in Claude Code.
- Phase 5 checks all pass.
