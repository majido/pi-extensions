# <Project name>

```yaml
slug: <project-slug>
tracker:
  kind: <linear|github|...>
  project_id: <id>
  project_url: <url>
  roadmap_doc_id: null            # set once the roadmap document exists
repos:
  - <owner/repo>                  # local: <path>
knowledge:
  namespaces:
    - projects/<owner>/<repo>
adapters:
  - <adapter-skill-name>          # supplies board conventions and delegation mechanics
cmux:
  group: "<workspace group name>"
```

## Policy (standing decisions from the owner)

- <what "done" means for the current milestone>
- <default verdict on proposed follow-up work>
- **Unattended runs may:** <explicit list>. They may **not:** <explicit list>.

## Notes

- <milestone ids, predecessor runbooks, anything a fresh session needs>
