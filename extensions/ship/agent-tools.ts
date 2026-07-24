/**
 * ship agent tools — the executor reports progress by CALLING a tool instead
 * of hand-writing state.json. The tool handler owns the write, so state.json is
 * always well-formed and consistent — we never depend on the agent to serialize
 * JSON correctly. The parent extension separately reconciles run liveness from
 * the runtime's status.json, so a forgotten final transition can't make the
 * footer lie.
 *
 * These tools are registered inside the ship executor child or the narrowly
 * identified in-memory scheduled subagent. The package's main extension
 * self-gates those contexts, so tools do not leak into normal parent sessions.
 * No file paths are embedded here (portable across install locations).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  appendJournal,
  readActiveState,
  writeState,
  type ShipState,
  type StageStatus,
} from "./state.ts";
import { registerRun } from "./global-index.ts";

const registeredApis = new WeakSet<object>();

function loadState(cwd: string): ShipState | undefined {
  return readActiveState(cwd);
}

/** Extract owner/repo + number from a GitHub PR URL; keeps the raw url too. */
function parsePrUrl(url: string): { repo?: string; number?: number; url: string } {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]), url } : { url };
}

/** Register the ship progress and cycle tools on the given API. */
export function registerShipTools(pi: ExtensionAPI) {
  if (registeredApis.has(pi as object)) return;
  registeredApis.add(pi as object);

  // ---- ship_stage: transition a pipeline stage --------------------------
  pi.registerTool({
    name: "ship_stage",
    label: "Ship Stage",
    description:
      "Report a ship pipeline stage transition. Call at the START of a stage (status=running) and again when it finishes (done/failed/skipped). The note is shown to the user: present tense while running, past tense when done. On the 'pr' stage, pass pr_url when the PR is open. Always call this instead of editing state.json by hand.",
    promptSnippet:
      "Report ship stage transitions via ship_stage(stage,status,note) instead of writing state.json.",
    parameters: Type.Object({
      stage: Type.String({ description: "Stage id: review|test|docs|lint|push|pr|ci|comments" }),
      status: Type.Union([
        Type.Literal("running"),
        Type.Literal("done"),
        Type.Literal("failed"),
        Type.Literal("skipped"),
      ]),
      note: Type.Optional(
        Type.String({ description: "Short one-liner shown to the user" }),
      ),
      model: Type.Optional(Type.String({ description: "Model handling this stage" })),
      pr_url: Type.Optional(
        Type.String({
          description:
            "PR URL (on the 'pr' stage). repo + number are auto-extracted from it.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const state = loadState(cwd);
      if (!state) return errText("no active ship run in this worktree");

      const stage = state.stages.find((s) => s.id === params.stage);
      if (!stage) return errText(`unknown stage '${params.stage}'`);
      if (params.stage === "pr" && params.status === "done" && !params.pr_url) {
        return errText("pr_url is required when completing the pr stage");
      }

      stage.status = params.status as StageStatus;
      if (params.note !== undefined) stage.note = params.note;
      if (params.model !== undefined) stage.model = params.model;
      const now = new Date().toISOString();
      if (params.status === "running") {
        stage.startedAt ??= now;
        state.stage = params.stage;
      } else {
        stage.endedAt = now;
      }
      if (params.pr_url) {
        state.pr = { ...(state.pr ?? {}), ...parsePrUrl(params.pr_url) };
      }

      if (params.status === "running") {
        state.status = "running";
      } else if (params.status === "failed") {
        state.status = "failed";
      } else if (params.status === "done" || params.status === "skipped") {
        const allDone = state.stages.every(
          (s) => s.status === "done" || s.status === "skipped",
        );
        const prDone = state.stages.find((s) => s.id === "pr")?.status === "done";
        const hasMonitoring = state.stages.some((s) => s.id === "ci" || s.id === "comments");
        const monitoringPending = state.stages.some(
          (s) => (s.id === "ci" || s.id === "comments") && s.status === "pending",
        );
        if (allDone && prDone && hasMonitoring) {
          state.status = "waiting-ci";
          state.ci ??= { intervalMin: 1, cycles: 0, checkConclusions: {} };
          state.ci.nextCheckAt ??= new Date(Date.now() + 60_000).toISOString();
        } else if (allDone) {
          state.status = "done";
        } else if (prDone && hasMonitoring && monitoringPending) {
          state.status = "waiting-ci";
          state.ci ??= { intervalMin: 1, cycles: 0, checkConclusions: {} };
          state.ci.nextCheckAt ??= new Date(Date.now() + 60_000).toISOString();
        }
      }
      writeState(state);
      appendJournal(
        cwd,
        state.runId,
        `${params.stage} — ${params.status}${params.note ? `: ${params.note}` : ""}${params.pr_url ? ` (pr ${params.pr_url})` : ""}`,
      );
      return okText(
        `ship_stage: ${params.stage} → ${params.status}${state.pr?.number ? ` (PR #${state.pr.number})` : ""}`,
      );
    },
  });

  // ---- ship_cycle: persist fresh-cycle bookkeeping -----------------------
  pi.registerTool({
    name: "ship_cycle",
    label: "Ship Cycle",
    description:
      "Record CI/comments cycle counters, backoff, schedule identity, and terminal state. Use after one fresh monitoring cycle; never hand-write state.json.",
    promptSnippet:
      "Record ship cycle metadata via ship_cycle after each CI/comments monitoring cycle.",
    parameters: Type.Object({
      cycles: Type.Optional(Type.Integer({ minimum: 0, description: "Completed cycle count" })),
      interval_min: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "Backoff interval in minutes" })),
      next_check_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      schedule_job_id: Type.Optional(Type.String()),
      schedule_job_name: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.Union([
          Type.Literal("waiting-ci"),
          Type.Literal("done"),
          Type.Literal("paused"),
          Type.Literal("failed"),
        ]),
      ),
      note: Type.Optional(Type.String({ description: "Continuity note for journal.md" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx.cwd);
      if (!state) return errText("no active ship run in this worktree");
      state.ci = {
        ...(state.ci ?? {}),
        ...(params.cycles === undefined ? {} : { cycles: params.cycles }),
        ...(params.interval_min === undefined ? {} : { intervalMin: params.interval_min }),
        ...(params.next_check_at === undefined ? {} : { nextCheckAt: params.next_check_at }),
        ...(params.schedule_job_id === undefined ? {} : { scheduleJobId: params.schedule_job_id }),
        ...(params.schedule_job_name === undefined ? {} : { scheduleJobName: params.schedule_job_name }),
        lastActivityAt: new Date().toISOString(),
      };
      if (params.status) state.status = params.status;
      writeState(state);
      registerRun(state);
      appendJournal(
        ctx.cwd,
        state.runId,
        `cycle ${state.ci.cycles ?? 0}${params.note ? ` — ${params.note}` : ""}${params.next_check_at ? `; next ${params.next_check_at}` : ""}`,
      );
      return okText(`ship_cycle recorded (${state.ci.cycles ?? 0})`);
    },
  });

  // ---- ship_decision_required: escalate a needsDecision -----------------
  pi.registerTool({
    name: "ship_decision_required",
    label: "Ship Decision Required",
    description:
      "Escalate a design-level or ambiguous item that needs a human decision. Records it, pauses the run, and notifies the user. Use for anything not a straightforward clear win.",
    promptSnippet:
      "Escalate architectural/ambiguous items via ship_decision_required instead of guessing.",
    parameters: Type.Object({
      stage: Type.String({ description: "Stage that raised this" }),
      what: Type.String({ description: "What needs deciding" }),
      tradeoff: Type.Optional(Type.String({ description: "The tradeoff at stake" })),
      suggestion: Type.Optional(Type.String({ description: "Your recommended option" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx.cwd);
      if (!state) return errText("no active ship run in this worktree");
      state.needsDecision.push({
        stage: params.stage,
        what: params.what,
        tradeoff: params.tradeoff,
        suggestion: params.suggestion,
      });
      state.status = "paused";
      if (state.ci) state.ci.nextCheckAt = null;
      writeState(state);
      appendJournal(ctx.cwd, state.runId, `needsDecision [${params.stage}]: ${params.what}`);
      return okText(`ship_decision_required recorded; run paused (${state.needsDecision.length} pending)`);
    },
  });
}

// Default export lets `pi -e agent-tools.ts` load the tools standalone (tests).
export default registerShipTools;

function okText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function errText(text: string) {
  return { content: [{ type: "text" as const, text: `ship tool error: ${text}` }], details: {}, isError: true };
}
