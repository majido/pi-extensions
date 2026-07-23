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
  type ShipState,
  type StageStatus,
} from "./state.ts";

function loadState(cwd: string): ShipState | undefined {
  return readActiveState(cwd);
}

/** Extract owner/repo + number from a GitHub PR URL; keeps the raw url too. */
function parsePrUrl(url: string): { repo?: string; number?: number; url: string } {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]), url } : { url };
}

export default function (pi: ExtensionAPI) {
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
      status: StringEnum(["running", "done", "failed", "skipped"] as const),
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
      writeState(state);
      appendJournal(ctx.cwd, state.runId, `needsDecision [${params.stage}]: ${params.what}`);
      return okText(`ship_decision_required recorded; run paused (${state.needsDecision.length} pending)`);
    },
  });
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
function errText(text: string) {
  return { content: [{ type: "text" as const, text: `ship tool error: ${text}` }], details: {}, isError: true };
}
