---
name: skillify
description: "Turn a repeatable workflow from the current session into a reusable skill draft. Use when the user says 'skillify this', 'turn this into a skill', 'save this as a skill', 'create a skill' or when a session uncovers a multi-step workflow worth capturing."
---

# Skillify

Use this skill when the current session uncovered a repeatable workflow that should become a reusable skill.

## Quality Gate

Before extracting a skill, all three should be true:
- "Could someone Google this in 5 minutes?" → No.
- "Is this specific to this codebase, project, or workflow?" → Yes.
- "Did this take real debugging, design, or operational effort to discover?" → Yes.

Prefer skills that encode decision-making heuristics, constraints, pitfalls, and verification steps. Avoid generic snippets, boilerplate, or library usage examples that belong in normal documentation.

## Workflow

1. Identify the repeatable task the session accomplished.
2. Extract:
   - inputs
   - ordered steps
   - success criteria
   - constraints / pitfalls
   - verification evidence
3. Decide the best target location for the skill:
   - **Project skill** — specific to a repo: `<repo>/.pi/agent/skills/<skill-name>/SKILL.md`
   - **User skill** — personal, cross-project: `~/.pi/agent/skills/<skill-name>/SKILL.md`
   - **Shared package** — reusable across users without any company specific details: add to a pi extensions package (e.g., `~/w/personal/pi-extensions/skills/<skill-name>/SKILL.md`)
   - **Documentation only** — if it doesn't warrant a full skill
4. Draft a complete skill file starting with YAML frontmatter.
   - Never emit plain markdown without frontmatter.
   - Minimum frontmatter:
     ```yaml
     ---
     name: <skill-name>
     description: "<one-line description of what it does and when to use it>"
     ---
     ```
   - The `description` is the primary trigger mechanism — make it specific and include concrete trigger phrases so the skill is discovered when relevant.
5. Draft the body with clear steps, success criteria, and pitfalls.
6. Point out anything still too fuzzy to encode safely.

## Writing Tips

- Keep the skill practical and scoped — one clear job.
- Prefer explicit success criteria over vague prose.
- Explain the **why** behind instructions rather than relying on heavy-handed MUSTs.
- If the workflow still has unresolved branching decisions, note them as open questions before drafting.
- Only capture workflows that are actually repeatable.

## Output

- Proposed skill name
- Target location (with rationale)
- Complete SKILL.md draft
- Open questions, if any
