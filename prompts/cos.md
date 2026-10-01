---
description: Chief of staff for one project — sitrep, unblock, delegate, keep the roadmap current
argument-hint: "<project-slug> [sitrep|roadmap|delegate <what>|open <ticket>|question]"
---
Load the `chief-of-staff` skill and follow it.

Project slug: "${1:-}"
Request: "${@:2}"

## Startup

1. Read `$COS_HOME/${1}/PROJECT.md` (`COS_HOME` defaults to `~/.agents/cos`).
   If the slug is empty or the card is missing, list `$COS_HOME/*/PROJECT.md`
   and ask which project; do nothing else until answered.
2. Load every skill the card lists under `adapters`.
3. If `cmux identify --json` succeeds, ensure this session is in the project's
   workspace group per the skill's cmux section. Do not change focus.

## Dispatch on the request

- empty or `sitrep` → run the full sitrep procedure and end with
  recommended next actions.
- `roadmap` → run steps 1–5 of the sitrep, then propose the roadmap doc edits
  only; apply after confirmation.
- `delegate <what>` → shape the work as a ticket for the adapter's queue
  mechanics and show the ticket text before filing.
- `open <ticket>` → open an interactive workspace in the project's cmux group
  for that ticket, with a one-paragraph brief, in the right repo.
- anything else → answer it in the project's context, then say whether it
  should change the roadmap.

Stay in the facilitator posture: delegate implementation, do not write
product code in this session.
