/**
 * ship agent tools — loaded ONLY inside the ship executor's child session
 * (via the ship agent's `subagentOnlyExtensions`). These let the executor
 * report progress by CALLING a tool instead of hand-writing state.json. The
 * tool handler owns the write, so state.json is always well-formed and
 * consistent — we never depend on the agent to serialize JSON correctly.
 *
 * The parent extension separately reconciles run liveness from the runtime's
 * status.json, so even a forgotten final transition can't make the footer lie.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  appendJournal,
  readActiveState,
  writeState,
  type Phase,
  type ShipState,
  type StageStatus,
} from "./state.ts";

function loadState(cwd: string): ShipState | undefined {
  return readActiveState(cwd);
}

export default function (pi: ExtensionAPI) {
  // ---- ship_stage: transition a pipeline stage --------------------------
  pi.registerTool({
    name: "ship_stage",
    label: "Ship Stage",
    description:
      "Report a ship pipeline stage transition. Call at the START of a stage (status=running) and again when it finishes (done/failed/skipped). The note is shown to the user: present tense while running, past tense when done. Always call this instead of editing state.json by hand.",
    promptSnippet:
      "Report ship stage transitions via ship_stage(stage,status,note) instead of writing state.json.",
    parameters: Type.Object({
      stage: Type.String({ description: "Stage id: review|test|docs|lint|push|pr|ci|comments" }),
      status: StringEnum(["running", "done", "failed", "skipped"] as const),
      note: Type.Optional(
        Type.String({ description: "Short one-liner shown to the user" }),
      ),
      model: Type.Optional(Type.String({ description: "Model handling this stage" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const state = loadState(cwd);
      if (!state) return errText("no active ship run in this worktree");

      const stage = state.stages.find((s) => s.id === params.stage);
      if (!stage) return errText(`unknown stage '${params.stage}'`);

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
      writeState(state);
      appendJournal(cwd, state.runId, `${params.stage} — ${params.status}${params.note ? `: ${params.note}` : ""}`);
      return okText(`ship_stage: ${params.stage} → ${params.status}`);
    },
  });

  // ---- ship_decision: escalate a needsDecision --------------------------
  pi.registerTool({
    name: "ship_decision",
    label: "Ship Decision",
    description:
      "Escalate a design-level or ambiguous item that needs a human decision. Records it, pauses the run, and notifies the user. Use for anything not a straightforward clear win.",
    promptSnippet:
      "Escalate architectural/ambiguous items via ship_decision instead of guessing.",
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
      writeState(state);
      appendJournal(ctx.cwd, state.runId, `needsDecision [${params.stage}]: ${params.what}`);
      return okText(`ship_decision recorded; run paused (${state.needsDecision.length} pending)`);
    },
  });

  // ---- ship_pr: record PR + advance phase -------------------------------
  pi.registerTool({
    name: "ship_pr",
    label: "Ship PR",
    description:
      "Record the pull request for this run and optionally advance the phase (to 'ci' once the PR is open, or 'done' when finished). Call after opening/finding the PR.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "owner/repo" })),
      number: Type.Optional(Type.Number({ description: "PR number" })),
      url: Type.Optional(Type.String({ description: "PR url" })),
      phase: Type.Optional(StringEnum(["pipeline", "ci", "done"] as const)),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = loadState(ctx.cwd);
      if (!state) return errText("no active ship run in this worktree");
      state.pr = {
        ...(state.pr ?? {}),
        ...(params.repo !== undefined ? { repo: params.repo } : {}),
        ...(params.number !== undefined ? { number: params.number } : {}),
        ...(params.url !== undefined ? { url: params.url } : {}),
      };
      if (params.phase) {
        state.phase = params.phase as Phase;
        if (params.phase === "done") state.status = "done";
      }
      writeState(state);
      appendJournal(ctx.cwd, state.runId, `pr recorded${params.number ? ` #${params.number}` : ""}${params.phase ? `; phase→${params.phase}` : ""}`);
      return okText(`ship_pr recorded${params.phase ? `; phase=${params.phase}` : ""}`);
    },
  });
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function errText(text: string) {
  return { content: [{ type: "text" as const, text: `ship tool error: ${text}` }], details: {}, isError: true };
}
