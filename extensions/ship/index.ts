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
 * Scope: /ship (Phase 1 stages), footer/status overlays, steering/abort,
 * Phase 2 fresh monitoring cycles, global fleet index, and catch-up-on-attach.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { footerLine, textStatus } from "./render.ts";
import { ShipOverlay, type OverlayAction } from "./overlay.ts";
import { registerShipTools } from "./agent-tools.ts";
import { interruptRun, spawnPipeline } from "./spawn.ts";
import { MAX_CYCLES } from "./cycle.ts";
import { listFleet, registerRun, removeRun, sweepIndex } from "./global-index.ts";
import { cancelScheduledJob } from "./schedule-store.ts";
import {
  DEFAULT_STAGES,
  createRun,
  reconcileLiveness,
  readActiveState,
  readState,
  readCurrentRunId,
  runDir,
  runIsLive,
  setCurrentPointer,
  tryClaimCycle,
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

/** Scheduled model jobs use an in-memory session. The explicit prompt marker
 * is the supported handoff signal; unlike process.env it is safe for concurrent
 * in-process scheduled jobs. */
function isScheduledCyclePrompt(prompt: unknown): boolean {
  return typeof prompt === "string" && prompt.includes("SHIP_SCHEDULED_CYCLE");
}

function isInMemorySession(ctx: any): boolean {
  try {
    return ctx?.sessionManager?.isPersisted?.() === false;
  } catch {
    return false;
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
  // Dual role, one discovered extension:
  //  - Inside the ship executor child (PI_SUBAGENT_CHILD_AGENT === "ship"),
  //    register only the ship_* progress tools. This is how the executor gets
  //    them — no subagentOnlyExtensions path (which resolves against the child
  //    cwd and isn't portable). Nothing leaks into the parent or other agents.
  //  - Otherwise (the interactive parent), register commands/footer/lifecycle.
  if (
    process.env.PI_SUBAGENT_CHILD === "1" &&
    process.env.PI_SUBAGENT_CHILD_AGENT === "ship"
  ) {
    registerShipTools(pi);
    return;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let savedCtx: any;
  const cycleSpawns = new Set<string>();

  const renderFooter = (ctx: any) => {
    savedCtx = ctx;
    const cwd = ctxCwd(ctx);
    if (!cwd) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    const raw = readActiveState(cwd);
    sweepIndex(getEvents(pi));
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
        // 80ms cadence matches pi's working spinner; each tick advances the
        // animation and re-reads state.json (live stage updates).
        const iv = setInterval(() => {
          comp.tick();
          tui.requestRender();
        }, 80);
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
          anchor: "top-right",
          width: "48%",
          minWidth: 46,
          maxHeight: "90%",
          offsetY: 1,
          offsetX: -1,
        },
      },
    );
    if (action?.kind === "steer") {
      ctx.ui.setEditorText("/ship-steer ");
    } else if (action?.kind === "abort") {
      await abortRun(ctx);
    }
  };

  const isMonitoringRun = (state: ShipState): boolean =>
    Boolean(state.pr?.url && state.stages.some((s) => s.id === "ci" || s.id === "comments"));

  const spawnCycle = async (ctx: any, state: ShipState): Promise<void> => {
    const latest = readState(state.cwd, state.runId);
    if (latest) state = latest;
    if (!isMonitoringRun(state) || cycleSpawns.has(state.runId) || runIsLive(state)) return;
    if ((state.ci?.cycles ?? 0) >= MAX_CYCLES) {
      cancelScheduledJob(state.cwd, state.ci?.scheduleJobId, state.ci?.scheduleJobName);
      state.status = "done";
      state.ci = { ...(state.ci ?? {}), nextCheckAt: null };
      writeState(state);
      removeRun(state.runId, state.cwd);
      return;
    }

    const events = getEvents(pi);
    if (!events) return;
    cycleSpawns.add(state.runId);
    const claimed = tryClaimCycle(state.cwd, state.runId, ctxSessionFile(ctx));
    if (!claimed) {
      cycleSpawns.delete(state.runId);
      return;
    }
    state = claimed;
    const instructions = [...(state.instructions ?? [])];

    try {
      const stages = state.stages
        .filter((s) => s.id === "ci" || s.id === "comments")
        .map((s) => s.id);
      const result = await spawnPipeline(events, {
        cwd: state.cwd,
        runId: state.runId,
        stateDir: runDir(state.cwd, state.runId),
        stages,
        phase: "ci",
        instructions,
      });
      if (result.error) {
        state.status = "failed";
        state.error = result.error;
        writeState(state);
        removeRun(state.runId, state.cwd);
        return;
      }
      state.instructions = [];
      state.currentRun = {
        asyncId: result.asyncId,
        asyncDir: result.asyncDir,
        spawnedBySessionId: ctxSessionFile(ctx),
      };
      writeState(state);
      registerRun(state);
      ctx.ui?.notify?.(
        `ship: monitoring cycle started${result.asyncId ? ` [${result.asyncId.slice(0, 8)}]` : ""}`,
        "info",
      );
    } finally {
      cycleSpawns.delete(state.runId);
    }
  };

  const maybeCatchUpCycle = async (ctx: any): Promise<void> => {
    const cwd = ctxCwd(ctx);
    const raw = cwd ? readActiveState(cwd) : undefined;
    if (!raw || raw.status === "done" || raw.status === "failed" || raw.status === "aborted") return;
    const { state, changed } = reconcileLiveness(raw);
    if (changed) writeState(state);
    if (!isMonitoringRun(state) || state.status !== "waiting-ci" || runIsLive(state)) return;
    const next = state.ci?.nextCheckAt;
    if (!next || Number.isNaN(Date.parse(next)) || Date.parse(next) > Date.now()) return;
    await spawnCycle(ctx, state);
  };

  // Abort/clear the active run. A live run is confirmed + interrupted; a
  // terminal or dead-executor run is cleared without ceremony.
  const abortRun = async (ctx: any): Promise<void> => {
    const cwd = ctxCwd(ctx);
    const runId = cwd ? readCurrentRunId(cwd) : undefined;
    const state = cwd && runId ? readState(cwd, runId) : undefined;
    if (!state) {
      ctx.ui.notify("ship: no active run to clear", "info");
      return;
    }
    if (runIsLive(state)) {
      const ok = await ctx.ui.confirm("Abort ship run?", `Stop ${state.runId}?`);
      if (!ok) return;
      const events = getEvents(pi);
      if (events && state.currentRun?.asyncId) interruptRun(events, state.currentRun.asyncId);
    }
    cancelScheduledJob(cwd!, state.ci?.scheduleJobId, state.ci?.scheduleJobName);
    state.status = "aborted";
    if (state.ci) state.ci.nextCheckAt = null;
    writeState(state);
    removeRun(state.runId, state.cwd);
    setCurrentPointer(cwd!, undefined);
    renderFooter(ctx);
    ctx.ui.notify(`ship: cleared ${state.runId}`, "info");
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
      // Only a genuinely live run (live status + running executor) blocks a new
      // one. Terminal or dead-executor runs are superseded automatically
      // (createRun overwrites the pointer), so a failed run never gets stuck.
      const existing = readActiveState(cwd);
      if (existing && (cycleSpawns.has(existing.runId) || runIsLive(existing))) {
        ctx.ui.notify(
          `ship: a run is already active (${existing.runId}). /ship-abort first or Ctrl+S to watch.`,
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
      registerRun(state);
      renderFooter(ctx);
      ctx.ui.notify(`ship: starting ${state.runId} (${stages.join(" → ")})`, "info");

      const result = await spawnPipeline(events, {
        cwd,
        runId: state.runId,
        stateDir: runDir(cwd, state.runId),
        stages,
      });

      if (result.error) {
        state.status = "failed";
        state.error = result.error;
        writeState(state);
        removeRun(state.runId, state.cwd);
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
      registerRun(state);
      ctx.ui.notify(
        `ship: executor running${result.asyncId ? ` [${result.asyncId.slice(0, 8)}]` : ""}.`,
        "info",
      );
      // Auto-open the status panel (TUI); falls back to a text summary elsewhere.
      await openOverlay(ctx);
    },
  });

  // ---- /ship-status ---------------------------------------------------------
  pi.registerCommand("ship-status", {
    description: "Open the ship pipeline status panel",
    handler: async (_args, ctx) => {
      await openOverlay(ctx);
    },
  });

  // ---- /ship-list -----------------------------------------------------------
  pi.registerCommand("ship-list", {
    description: "Show ship runs across worktrees",
    handler: async (_args, ctx) => {
      const fleet = listFleet(getEvents(pi));
      const lines = fleet.length
        ? fleet.map((entry) => {
            const state = entry.state;
            const next = state?.ci?.nextCheckAt ? ` next ${state.ci.nextCheckAt}` : "";
            return `${state?.status ?? "?"} ${state?.stage ?? "—"} ${entry.runId} — ${entry.cwd}${next}`;
          })
        : ["no active ship runs"];
      if (ctx.mode !== "tui") {
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      await ctx.ui.custom(
        (tui: any, theme: any, _kb: any, done: () => void) => ({
          render: (width: number) => [
            theme.fg("accent", theme.bold("🚀 ship fleet")),
            "",
            ...lines.map((line) => truncateToWidth(line, Math.max(12, width - 4))),
            "",
            theme.fg("dim", "esc/q close"),
          ],
          invalidate: () => {},
          handleInput: (data: string) => {
            if (data === "q" || data === "\u001b") done();
            tui.requestRender();
          },
        }),
        { overlay: true, overlayOptions: { anchor: "top-right", width: "60%", maxHeight: "80%" } },
      );
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
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (isInMemorySession(ctx) && isScheduledCyclePrompt(event.prompt)) {
      registerShipTools(pi);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (isInMemorySession(ctx)) return;
    savedCtx = ctx;
    const cwd = ctxCwd(ctx);
    if (cwd) {
      const state = readActiveState(cwd);
      if (state && state.status !== "done" && state.status !== "aborted") {
        ctx.ui.notify(
          `ship run active for this worktree (${state.stage ?? "…"}) — Ctrl+S to view`,
          "info",
        );
        // Catch-up-on-attach: a prior session's schedule may have died with
        // its in-memory scheduler. A due state file is the durable trigger.
        void maybeCatchUpCycle(ctx);
      }
    }
    renderFooter(ctx);

    stopTimer();
    timer = setInterval(() => {
      if (!savedCtx) return;
      try {
        renderFooter(savedCtx);
        void maybeCatchUpCycle(savedCtx);
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
