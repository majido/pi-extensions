# Third-party pi packages

Packages installed via `pi install …` (recorded in `~/.pi/agent/settings.json`
under `packages`). This file is the durable note of what's installed and why —
update it whenever adding/removing a package.

| Package | Why |
|---|---|
| `npm:pi-subagents` | Subagent orchestration: single/parallel/chain delegation, async runs, supervisor channel. |
| `npm:pi-intercom` | Registers the `intercom` tool at extension load. Required alongside pi-subagents: without it, the intercom bridge appends `intercom` to child tool allowlists but the native fallback registers too late (`before_agent_start`), so any child agent with an explicit `tools` allowlist fails to spawn (`requested unavailable child tools: intercom`). Installed 2026-07-20. |
| `npm:pi-mcp-adapter` | MCP gateway tool (`mcp`) — connect/call MCP servers (Slack, GitHub, Datadog, Linear, chrome-devtools, …). |
| `npm:@vanillagreen/pi-session-manager` | Session management utilities. |
| `npm:pi-slopchop` | Slop removal / output quality. |
| `https://github.com/tintinweb/pi-schedule-prompt` | `schedule_prompt` tool — cron/interval/once scheduled prompts. |
| `../../w/personal/pi-extensions` | This repo (local path install): personal extensions, skills, prompts, themes. |

## Notes

- `~/.pi/agent/extensions/subagent/config.json` may carry a
  `{"intercomBridge": {"mode": "off"}}` override from before pi-intercom was
  installed — remove it to restore full child↔parent intercom coordination.
- On pi upgrades, re-verify subagent spawning with an allowlisted agent
  (`subagent({ action: "doctor" })` / a trivial `worker` run) since the
  bridge/allowlist interaction is version-sensitive.
