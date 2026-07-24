import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCyclePrompt,
  buildSchedulePromptArgs,
  cycleJobName,
  CYCLE_EXTENSIONS,
  CYCLE_SKILLS,
} from "./ship/cycle.ts";
import shipExtension from "./ship/index.ts";
import { listFleet, registerRun, sweepIndex } from "./ship/global-index.ts";
import {
  reconcileLiveness,
  runIsLive,
  setCurrentPointer,
  tryClaimCycle,
  writeState,
  type ShipState,
} from "./ship/state.ts";

function state(cwd: string, status: ShipState["status"] = "waiting-ci"): ShipState {
  return {
    runId: "run-1",
    cwd,
    status,
    stages: [
      { id: "pr", status: "done" },
      { id: "ci", status: "done" },
      { id: "comments", status: "done" },
    ],
    needsDecision: [],
    instructions: [],
    startedAt: new Date().toISOString(),
    pr: { repo: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/1" },
    ci: {
      cycles: 1,
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
      scheduleJobId: "job-1",
      scheduleJobName: "ship-run-1-1",
    },
  };
}

test("scheduled marker activates ship tools only in an in-memory subagent", async () => {
  const tools: string[] = [];
  const definitions: any[] = [];
  const shortcuts: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerCommand: () => {},
    registerShortcut: (shortcut: string) => shortcuts.push(shortcut),
    registerTool: (tool: { name: string }) => {
      tools.push(tool.name);
      definitions.push(tool);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
    events: { emit: () => {} },
  } as any;
  shipExtension(pi);
  assert.deepEqual(shortcuts, ["ctrl+shift+s"]);
  await handlers.get("before_agent_start")?.(
    { prompt: "SHIP_SCHEDULED_CYCLE run-1" },
    { sessionManager: { isPersisted: () => false } },
  );
  assert.deepEqual(tools.sort(), ["ship_cycle", "ship_decision_required", "ship_stage"]);
  const root = mkdtempSync(join(tmpdir(), "ship-tool-"));
  try {
    const active = state(root);
    writeState(active);
    setCurrentPointer(root, active.runId);
    const stageTool = definitions.find((tool) => tool.name === "ship_stage");
    const result = await stageTool.execute("test", { stage: "pr", status: "done" }, undefined, undefined, { cwd: root });
    assert.match(JSON.stringify(result), /pr_url is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const normalTools: string[] = [];
  const normalPi = { ...pi, registerTool: (tool: { name: string }) => normalTools.push(tool.name) } as any;
  shipExtension(normalPi);
  await handlers.get("before_agent_start")?.(
    { prompt: "SHIP_SCHEDULED_CYCLE run-1" },
    { sessionManager: { isPersisted: () => true } },
  );
  assert.deepEqual(normalTools, []);
});

test("cycle prompt explicitly reconstructs state and requires fire-time resources", () => {
  const prompt = buildCyclePrompt({ runId: "r", cwd: "/tmp/repo", stateDir: "/tmp/repo/.pi/ship/r" });
  assert.match(prompt, /state\.json/);
  assert.match(prompt, /ship_cycle/);
  assert.match(prompt, /schedule_prompt/);
  assert.match(prompt, /SHIP_SCHEDULED_CYCLE/);
  assert.match(prompt, /Fire-time extensions: pi-extensions, pi-schedule-prompt/);
  assert.match(prompt, /Fire-time skills: ship, ci-triage-fix/);
  assert.equal(cycleJobName("run-1", 2), "ship-run-1-2");
  const schedule = buildSchedulePromptArgs("run-1", 2, "+2m", "sonnet");
  assert.equal(schedule.model, "sonnet");
  assert.deepEqual(schedule.extensions, ["pi-extensions", "pi-schedule-prompt"]);
  assert.ok((schedule.skills as string[]).includes("pr-comment-triage-fix"));
  assert.deepEqual(CYCLE_EXTENSIONS, ["pi-extensions", "pi-schedule-prompt"]);
  assert.ok(CYCLE_SKILLS.includes("ship"));
  assert.ok(CYCLE_SKILLS.includes("ci-triage-fix"));
  assert.ok(CYCLE_SKILLS.includes("pr-comment-triage-fix"));
});

test("ended monitoring executors get a due retry and attached sessions claim only once", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-claim-"));
  const cwd = join(root, "worktree");
  try {
    const current = state(cwd, "running");
    current.stages[1] = { id: "ci", status: "running", note: "checking" };
    current.currentRun = { asyncId: "async-1", asyncDir: join(root, "runtime") };
    mkdirSync(current.currentRun.asyncDir, { recursive: true });
    writeFileSync(join(current.currentRun.asyncDir, "status.json"), JSON.stringify({ state: "complete" }));
    writeState(current);

    const reconciled = reconcileLiveness(current);
    assert.equal(reconciled.state.status, "waiting-ci");
    assert.ok(reconciled.state.ci?.nextCheckAt);
    assert.equal(reconciled.state.currentRun, undefined);
    reconciled.state.ci!.nextCheckAt = new Date(Date.now() - 1).toISOString();
    writeState(reconciled.state);

    const first = tryClaimCycle(cwd, current.runId, "session-a");
    assert.ok(first?.currentRun?.claimId);
    assert.equal(runIsLive(first!), true);
    assert.equal(tryClaimCycle(cwd, current.runId, "session-b"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global index lists active runs and removes terminal runs plus their persisted job", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-index-"));
  const indexPath = join(root, "global", "index.json");
  const cwd = join(root, "worktree");
  const previous = process.env.PI_SHIP_INDEX_PATH;
  process.env.PI_SHIP_INDEX_PATH = indexPath;
  try {
    const active = state(cwd);
    writeState(active);
    writeFileSync(
      join(cwd, ".pi", "schedule-prompts.json"),
      JSON.stringify({ version: 1, jobs: [{ id: "job-1", name: "ship-run-1-1" }] }),
    );
    registerRun(active);
    active.currentRun = { asyncId: "async-1", asyncDir: join(root, "runtime") };
    writeState(active);
    registerRun(active);
    const fleet = listFleet();
    assert.equal(fleet.length, 1);
    assert.equal(fleet[0].asyncId, "async-1");

    writeState({ ...active, status: "done", ci: { ...active.ci, nextCheckAt: null } });
    assert.equal(sweepIndex().entries.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".pi", "schedule-prompts.json"), "utf8")).jobs, []);
  } finally {
    if (previous === undefined) delete process.env.PI_SHIP_INDEX_PATH;
    else process.env.PI_SHIP_INDEX_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
