export const CYCLE_SKILLS = [
  "ship",
  "ci-triage-fix",
  "pr-comment-triage-fix",
  "verify-change",
  "documentation-and-adrs",
  "commit",
  "pull-requests",
  "humanizer",
  "code-review-and-quality",
] as const;

/** Path fragments understood by pi-schedule-prompt's extension filter. */
export const CYCLE_EXTENSIONS = ["pi-extensions", "pi-schedule-prompt"] as const;

export const DEFAULT_CYCLE_MODEL = "sonnet";
export const FIRST_CYCLE_DELAY = "+1m";
export const MAX_CYCLES = 200;
export const MAX_INTERVAL_MIN = 60;

export function cycleJobName(runId: string, cycle: number): string {
  return `ship-${runId}-${cycle}`;
}

export function buildSchedulePromptArgs(
  runId: string,
  cycle: number,
  schedule: string,
  model = DEFAULT_CYCLE_MODEL,
): Record<string, unknown> {
  return {
    action: "add",
    name: cycleJobName(runId, cycle),
    schedule,
    type: "once",
    model,
    prompt: `SHIP_SCHEDULED_CYCLE Run one fresh ship CI/comments cycle for ${runId}.`,
    extensions: [...CYCLE_EXTENSIONS],
    skills: [...CYCLE_SKILLS],
  };
}

export function buildCyclePrompt(params: {
  runId: string;
  cwd: string;
  stateDir: string;
  instruction?: string;
}): string {
  return [
    "SHIP_SCHEDULED_CYCLE",
    "You are the ship executor for one fresh CI/comments monitoring cycle.",
    `Fire-time extensions: ${CYCLE_EXTENSIONS.join(", ")}`,
    `Fire-time skills: ${CYCLE_SKILLS.join(", ")}`,
    "Load the ship skill and all stage skills listed in the scheduled job.",
    "Read state.json, journal.md, instructions[], git status/log, and the PR checks/reviews before acting.",
    "Run exactly one CI + review-comments cycle; do not assume memory from an earlier cycle.",
    `runId: ${params.runId}`,
    `worktree: ${params.cwd}`,
    `state dir: ${params.stateDir}`,
    "Report stage transitions through ship_stage and cycle metadata through ship_cycle; never hand-write state.json.",
    "Append detailed continuity notes to journal.md. Stop on merged/closed, needsDecision, or 200 cycles.",
    "If continuing, use schedule_prompt in subagent mode with the same ship skill/extension lists and the computed backoff.",
    params.instruction ? `User instruction to honor: ${params.instruction}` : "",
  ].filter(Boolean).join("\n");
}
