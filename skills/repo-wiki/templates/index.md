# <Project> Wiki

Documentation of the system as it is — for human and agent readers.
**Read this index first, then open only the pages relevant to your task.**

| Page | Covers |
|------|--------|
| [architecture.md](architecture.md) | System overview, components, data flow |
| [<page>.md](<page>.md) | <one-line summary> |

Related (not wiki): design docs in `docs/`, plans in `docs/plans/`.

## Maintenance

If your change invalidates a page, update the affected sections (surgically — don't
regenerate) in the same PR, and refresh its `last_verified` / `verified_against`
frontmatter. New pages must be added to the table above in the same commit.
Cosmetic/test-only/pure-refactor changes need no update.
