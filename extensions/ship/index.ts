/**
 * ship — staged quality pipeline for the current worktree change.
 *
 *   review → test → docs → lint → push → PR → CI → comments
 *
 * The extension is orchestrator/renderer: it creates the run, spawns the ship
 * executor (a detached async subagent that loads the `ship` skill and is the
 * single writer), renders progress from worktree-local state.json, and routes
 * steering. See docs/plans/ship-pipeline.md for the full design.
 *
 * v1 scope: /ship (Phase 1 stages), footer status, /ship-status (text),
 * /ship-steer (via instructions[]), /ship-abort, catch-up-on-attach.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { footerLine, textStatus } from "./render.ts";
import { ShipOverlay, type OverlayAction } from "./overlay.ts";
import { interruptRun, spawnPipeline } from "./spawn.ts";
import {
  DEFAULT_STAGES,
  createRun,
  reconcileLiveness,
  readActiveState,
  readState,
  readCurrentRunId,
  runDir,
  setCurrentPointer,
  writeState,
  type ShipState,
} from "./state.ts";

const WIDGET_ID = "ship";
const TICK_MS = 5_000;

type PiEvents = {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
};

function getEvents(pi: ExtensionAPI): PiEvents | undefined {
  const events = (pi as unknown as { events?: PiEvents }).events;
  return events && typeof events.emit === "function" ? events : undefined;
}

function ctxCwd(ctx: any): string | undefined {
  try {
    return ctx?.sessionManager?.getCwd?.() ?? ctx?.cwd;
  } catch {
    return ctx?.cwd;
  }
}

function ctxSessionFile(ctx: any): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionFile?.();
  } catch {
    return undefined;
  }
}

/** Parse `--only a,b`, `--from stage`, `--dry` and an optional title. */
function parseArgs(args: string): {
  only?: string[];
  from?: string;
  dry: boolean;
  title?: string;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let only: string[] | undefined;
  let from: string | undefined;
  let dry = false;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--dry") dry = true;
    else if (t === "--only") only = tokens[++i]?.split(",").filter(Boolean);
    else if (t === "--from") from = tokens[++i];
    else rest.push(t);
  }
  return { only, from, dry, title: rest.join(" ") || undefined };
}

function resolveStages(opts: {
  only?: string[];
  from?: string;
}): string[] {
  let stages = [...DEFAULT_STAGES];
  if (opts.from) {
    const idx = stages.indexOf(opts.from);
    if (idx >= 0) stages = stages.slice(idx);
  }
  if (opts.only) stages = stages.filter((s) => opts.only!.includes(s));
  return stages;
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let savedCtx: any;

  const renderFooter = (ctx: any) => {
    savedCtx = ctx;
    const cwd = ctxCwd(ctx);
    if (!cwd) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    const raw = readActiveState(cwd);
    if (!raw || raw.status === "done" || raw.status === "aborted") {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    // Liveness comes from the runtime, not the agent: if the executor async run
    // has ended, correct a stale "running" so the footer never lies. Persist
    // the correction once so it sticks and we stop re-checking.
    const { state, changed } = reconcileLiveness(raw);
    if (changed) writeState(state);
    if (state.status === "done" || state.status === "aborted") {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    ctx.ui.setWidget(
      WIDGET_ID,
      (_tui: any, theme: any) => ({
        render: (width: number) => [footerLine(state, theme, width)],
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    );
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  // Open the status overlay (TUI only). Returns the chosen action so the
  // caller can run dialog/confirm flows outside the component.
  const openOverlay = async (ctx: any): Promise<void> => {
    const cwd = ctxCwd(ctx);
    const state = cwd ? readActiveState(cwd) : undefined;
    if (!cwd || !state) {
      ctx.ui.notify("ship: no active run in this worktree", "info");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify(textStatus(state), "info");
      return;
    }
    const action = await ctx.ui.custom<OverlayAction>(
      (tui: any, theme: any, _kb: any, done: (a: OverlayAction) => void) => {
        const comp = new ShipOverlay(cwd, theme, tui, done);
        const iv = setInterval(() => {
          comp.invalidate();
          tui.requestRender();
        }, 2000);
        (iv as { unref?: () => void }).unref?.();
        comp.onClose = () => clearInterval(iv);
        return {
          render: (w: number) => comp.render(w),
          invalidate: () => comp.invalidate(),
          handleInput: (d: string) => comp.handleInput(d),
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "48%",
          minWidth: 46,
          maxHeight: "85%",
          margin: 1,
        },
      },
    );
    if (action?.kind === "steer") {
      ctx.ui.setEditorText("/ship-steer ");
    } else if (action?.kind === "abort") {
      await abortRun(ctx);
    }
  };

  // Abort the active run: confirm, interrupt the executor, mark aborted.
  const abortRun = async (ctx: any): Promise<void> => {
    const cwd = ctxCwd(ctx);
    const runId = cwd ? readCurrentRunId(cwd) : undefined;
    const state = cwd && runId ? readState(cwd, runId) : undefined;
    if (!state) {
      ctx.ui.notify("ship: no active run to abort", "info");
      return;
    }
    const ok = await ctx.ui.confirm("Abort ship run?", `Stop ${state.runId}?`);
    if (!ok) return;
    const events = getEvents(pi);
    if (events && state.currentRun?.asyncId) interruptRun(events, state.currentRun.asyncId);
    state.status = "aborted";
    writeState(state);
    setCurrentPointer(cwd!, undefined);
    renderFooter(ctx);
    ctx.ui.notify(`ship: aborted ${state.runId}`, "info");
  };

  // ---- /ship ----------------------------------------------------------------
  pi.registerCommand("ship", {
    description:
      "Run the quality pipeline (review→test→docs→lint→push→PR→CI→comments) for this worktree",
    handler: async (args, ctx) => {
      const cwd = ctxCwd(ctx);
      if (!cwd) {
        ctx.ui.notify("ship: no working directory for this session", "error");
        return;
      }
      const existing = readActiveState(cwd);
      if (existing && existing.status !== "done" && existing.status !== "aborted") {
        ctx.ui.notify(
          `ship: a run is already active (${existing.runId}). /ship-abort first or /ship-status.`,
          "warning",
        );
        return;
      }

      const parsed = parseArgs(args);
      const stages = resolveStages(parsed);
      if (stages.length === 0) {
        ctx.ui.notify("ship: no stages selected", "error");
        return;
      }

      if (parsed.dry) {
        ctx.ui.notify(
          `ship (dry): would run ${stages.join(" → ")}${parsed.title ? ` for "${parsed.title}"` : ""}`,
          "info",
        );
        return;
      }

      const events = getEvents(pi);
      if (!events) {
        ctx.ui.notify(
          "ship: pi-subagents RPC bus unavailable; cannot spawn executor",
          "error",
        );
        return;
      }

      const state = createRun({
        cwd,
        stages,
        parentSessionFile: ctxSessionFile(ctx),
        title: parsed.title,
      });
      renderFooter(ctx);
      ctx.ui.notify(`ship: starting ${state.runId} (${stages.join(" → ")})`, "info");

      const result = await spawnPipeline(events, {
        cwd,
        runId: state.runId,
        stateDir: runDir(cwd, state.runId),
        stages,
        context: "fork",
      });

      if (result.error) {
        state.status = "failed";
        writeState(state);
        renderFooter(ctx);
        ctx.ui.notify(`ship: spawn failed — ${result.error}`, "error");
        return;
      }

      state.currentRun = {
        asyncId: result.asyncId,
        asyncDir: result.asyncDir,
        spawnedBySessionId: ctxSessionFile(ctx),
      };
      writeState(state);
      ctx.ui.notify(
        `ship: executor running${result.asyncId ? ` [${result.asyncId.slice(0, 8)}]` : ""}. Ctrl+S or /ship-status to watch.`,
        "info",
      );
    },
  });

  // ---- /ship-status ---------------------------------------------------------
  pi.registerCommand("ship-status", {
    description: "Open the ship pipeline status panel",
    handler: async (_args, ctx) => {
      await openOverlay(ctx);
    },
  });

  // ---- /ship-steer ----------------------------------------------------------
  pi.registerCommand("ship-steer", {
    description: "Send guidance to the ship run (applied on its next cycle)",
    handler: async (args, ctx) => {
      const cwd = ctxCwd(ctx);
      const runId = cwd ? readCurrentRunId(cwd) : undefined;
      const state = cwd && runId ? readState(cwd, runId) : undefined;
      if (!state) {
        ctx.ui.notify("ship: no active run to steer", "warning");
        return;
      }
      const msg = args.trim();
      if (!msg) {
        ctx.ui.notify("ship-steer: provide a message", "warning");
        return;
      }
      state.instructions = [...(state.instructions ?? []), msg];
      writeState(state);
      ctx.ui.notify(
        "ship: steering queued — the executor applies it on its next run/cycle",
        "info",
      );
    },
  });

  // ---- /ship-abort ----------------------------------------------------------
  pi.registerCommand("ship-abort", {
    description: "Stop the active ship run (keeps artifacts)",
    handler: async (_args, ctx) => {
      await abortRun(ctx);
    },
  });

  // ---- Ctrl+S opens the status panel ----------------------------------------
  pi.registerShortcut?.("ctrl+s", {
    description: "Open ship pipeline status panel",
    handler: async (ctx: any) => {
      await openOverlay(ctx);
    },
  });

  // ---- lifecycle: attach + footer ticker ------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    savedCtx = ctx;
    const cwd = ctxCwd(ctx);
    if (cwd) {
      const state = readActiveState(cwd);
      if (state && state.status !== "done" && state.status !== "aborted") {
        ctx.ui.notify(
          `ship run active for this worktree (${state.stage ?? "…"}) — Ctrl+S to view`,
          "info",
        );
        // catch-up-on-attach (v2): if ci.nextCheckAt is in the past and no live
        // run is recorded, fire a cycle here. Wired when Phase 2 lands.
      }
    }
    renderFooter(ctx);

    stopTimer();
    timer = setInterval(() => {
      if (!savedCtx) return;
      try {
        renderFooter(savedCtx);
      } catch {
        savedCtx = undefined;
        stopTimer();
      }
    }, TICK_MS);
    (timer as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", async () => {
    stopTimer();
    savedCtx = undefined;
  });
}
