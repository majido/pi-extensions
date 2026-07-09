# ao adoption — Phase 1

Adopt a subset of [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) into
`~/w/personal/pi-extensions` (already a pi package). Retire overlapping personal skills.

## Scope

Adopt 5 commands and the skills that power them:

| Command | Principle |
|---------|-----------|
| `/plan` | Small, atomic tasks |
| `/build` | One slice at a time |
| `/test` | Tests are proof |
| `/review` | Improve code health |
| `/code-simplify` | Clarity over cleverness |

**No personas/subagents this phase** — none of these 5 commands or their skills invoke a
persona (`code-reviewer` etc. are only used by `/ship`, out of scope). Keep existing
subagents (`oracle`, `researcher`, `verifier`) untouched.

## Decisions (locked)

- Commands **unprefixed** (`/plan`, not `/ao-plan`).
- Retired skills moved via **`git mv` to `_retired/`** in `~/.agents/skills/`.
- `references/*.md` in a **shared top-level `references/` dir**; skills link across via
  `../../references/foo.md` (no duplication). NOT copied per-skill.
- Plan lives here but is **not committed**.

## Skill closure (10 skills)

Directly required + transitive references:

| Command | Direct | Transitive |
|---------|--------|-----------|
| `/plan` | planning-and-task-breakdown | — |
| `/build` | incremental-implementation, test-driven-development | planning-and-task-breakdown, debugging-and-error-recovery, doubt-driven-development |
| `/test` | test-driven-development | browser-testing-with-devtools |
| `/review` | code-review-and-quality | security-and-hardening, performance-optimization |
| `/code-simplify` | code-simplification | code-review-and-quality |

**Full set:** planning-and-task-breakdown, incremental-implementation,
test-driven-development, code-review-and-quality, code-simplification,
debugging-and-error-recovery, doubt-driven-development, browser-testing-with-devtools,
security-and-hardening, performance-optimization.

Skip `using-agent-skills` (routing meta-skill) — piecemeal adoption doesn't need it.

## Shared references (top-level, no duplication)

ao uses repo-root-relative `references/foo.md`. pi resolves skill paths **against the
skill directory** (skills.md: "use relative paths from the skill directory"). So a shared
top-level dir is reached from a skill via `../../references/foo.md`
(`skills/<name>/` → up 2 → package root → `references/`).

Create one shared dir and link from each skill (no copies):

```
pi-extensions/references/
  definition-of-done.md
  performance-checklist.md
  security-checklist.md
  orchestration-patterns.md
  testing-patterns.md
```

(pi has no `references` manifest key — the dir just exists on disk; skills reach it by
relative path.)

Rewrite each SKILL.md link `references/foo.md` → `../../references/foo.md`, and add one
explicit sentence per skill: "resolve relative to this skill's directory." Which skills
link which file:

| Skill | Links (../../references/) |
|-------|--------------------------|
| planning-and-task-breakdown | definition-of-done.md |
| incremental-implementation | definition-of-done.md |
| test-driven-development | testing-patterns.md |
| code-review-and-quality | performance-checklist.md, security-checklist.md |
| doubt-driven-development | orchestration-patterns.md |
| security-and-hardening | security-checklist.md |
| performance-optimization | performance-checklist.md |
| (others) | none |

Fallback if `../../` proves unreliable: promote each checklist to its own 1-file skill and
use name references ("see the `security-checklist` skill") — pi's endorsed cross-skill
pattern, zero path fragility.

## Target layout

```
~/w/personal/pi-extensions/
├── skills/
│   ├── commit/  skillify/                 # existing, untouched
│   ├── planning-and-task-breakdown/       # SKILL.md (links ../../references/)
│   ├── incremental-implementation/        # SKILL.md (links ../../references/)
│   ├── test-driven-development/           # SKILL.md (links ../../references/)
│   ├── code-review-and-quality/           # SKILL.md (links ../../references/)
│   ├── code-simplification/               # SKILL.md
│   ├── debugging-and-error-recovery/      # SKILL.md
│   ├── doubt-driven-development/          # SKILL.md (links ../../references/)
│   ├── browser-testing-with-devtools/     # SKILL.md
│   ├── security-and-hardening/            # SKILL.md (links ../../references/)
│   └── performance-optimization/          # SKILL.md (links ../../references/)
├── references/                            # shared, top-level (see below)
│   ├── definition-of-done.md  performance-checklist.md
│   ├── security-checklist.md  orchestration-patterns.md
│   └── testing-patterns.md
├── prompts/
│   ├── pr-sitter*.md                      # existing, untouched
│   ├── plan.md  build.md  test.md
│   └── review.md  code-simplify.md
└── docs/RETIRED.md                        # committed: overlap + rollback record
```

`package.json` already declares `skills:["./skills"]` and `prompts:["./prompts"]` — no
manifest change needed.

## Command → prompt conversion

ao commands are **full workflows**, not thin "invoke skill X" triggers. pi prompt
templates carry the entire body AND support arguments, so they port near-verbatim.

**Source: `commands/*.toml`** (Gemini format), NOT `.claude/commands/*.md`. The toml
prompts already strip the `agent-skills:` namespace (they say `incremental-implementation`,
not `agent-skills:...`) — matches pi skill names, less editing.

Mapping: toml `description` → frontmatter `description:`; toml `prompt = """..."""` body →
markdown body verbatim; "the arguments select the mode" → pi `$@` / `${@:-default}`.

| pi prompt | Source toml | Arg handling |
|-----------|-------------|--------------|
| plan.md | planning.toml | none (optional scope `$@`) |
| build.md | build.toml | `${@:-default}` for auto/all mode |
| test.md | test.toml | none |
| review.md | review.toml | optional `$@` scope |
| code-simplify.md | code-simplify.toml | optional `$@` scope |

build.md needs the explicit mode line (Gemini injects args implicitly; pi needs the token):

```markdown
---
description: Implement tasks incrementally...
argument-hint: "[auto]"
---
Invoke the incremental-implementation skill alongside test-driven-development.

Requested mode: "${@:-default}"
Treat `auto` or `all` as autonomous mode; anything else (or empty) is single-task.
...(rest of build.toml body verbatim)...
```

Keep all workflow logic verbatim: modes, spec-path checks, clean-baseline gate,
single-checkpoint approval, per-task RED→GREEN→commit loop, stop-conditions.

## Retirement (in ~/.agents/skills/)

`~/.pi/agent/skills` is a symlink to `~/.agents/skills` — one physical location.

`git mv` these to `~/.agents/skills/_retired/` (underscore prefix = not discovered):

| ao skill | Retire | Notes |
|----------|--------|-------|
| planning-and-task-breakdown | writing-plans | full overlap |
| incremental-implementation | personal/executing-plans | full overlap |
| code-simplification | code-refactoring | full overlap |
| code-review-and-quality | review-plans | overlap (plan review → code review) |

**Flag, do NOT retire** (partial overlap, keep for now — reassess later phases):
- python-testing-patterns, python-test-reviewer (Python-specific; TDD is generic)
- user-story-splitting (product/story, not eng tasks)
- personal/scala-architecture-review (Scala-specific)
- subagent `verifier` (read-only reporting, different role from `/test`)

## docs/RETIRED.md (committed)

Table: ao skill → retired skill → old path → new path (`_retired/`) → rollback command
(`git mv _retired/X X`). Covers both repos even though retired files sit in `~/.agents/skills`.

## Steps

1. Copy 10 skill dirs from upstream into `pi-extensions/skills/`.
2. Create top-level `references/` with the 5 shared files; rewrite skill links to `../../references/foo.md` + add "resolve relative to this skill's directory" note.
3. Create 5 `prompts/*.md` from `commands/*.toml` bodies (verbatim); add `$@` mode token to build.md.
4. `git mv` the 4 overlapping skills to `~/.agents/skills/_retired/`.
5. Write `docs/RETIRED.md`.
6. Verify: `pi --no-skills` off; confirm `/plan /build /test /review /code-simplify`
   appear and load their skills; confirm retired skills gone from discovery.
7. Open PR in pi-extensions (additive half + RETIRED.md). Retirement `git mv` is a
   separate change in `~/.agents/skills`.

## Verification

- [ ] `/plan /build /test /review /code-simplify` registered as prompt commands
- [ ] Each command loads its ao skill (skill read on invoke)
- [ ] Shared `../../references/*.md` resolve from each skill (no broken paths)
- [ ] Retired skills absent from skill discovery list
- [ ] Existing skills/prompts/extensions unaffected
- [ ] `npm test` still passes in pi-extensions
