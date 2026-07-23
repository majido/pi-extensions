/**
 * ship render helpers — footer widget line + text status summary.
 * Display-only; state.json is the source of truth.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ShipState, StageState } from "./state.ts";

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

const GLYPH: Record<string, string> = {
  done: "✓",
  running: "●",
  failed: "✗",
  skipped: "⊘",
  pending: "○",
};

const STAGE_COLOR: Record<string, string> = {
  done: "success",
  running: "accent",
  failed: "error",
  skipped: "dim",
  pending: "dim",
};

function stageGlyph(s: StageState, theme: ThemeLike): string {
  return theme.fg(STAGE_COLOR[s.status] ?? "muted", GLYPH[s.status] ?? "?");
}

function activeStage(state: ShipState): StageState | undefined {
  return (
    state.stages.find((s) => s.status === "running") ??
    state.stages.find((s) => s.status === "failed") ??
    [...state.stages].reverse().find((s) => s.status === "done")
  );
}

function progress(state: ShipState): string {
  const done = state.stages.filter(
    (s) => s.status === "done" || s.status === "skipped",
  ).length;
  return `${done}/${state.stages.length}`;
}

/** Single compact footer line: "ship ● docs 3/8 · updating wiki…" */
export function footerLine(
  state: ShipState,
  theme: ThemeLike,
  width: number,
): string {
  const label = theme.fg("accent", theme.bold("ship"));
  const active = activeStage(state);
  const parts: string[] = [label];

  if (state.status === "aborted" || state.status === "done") {
    parts.push(theme.fg("dim", state.status));
  } else if (active) {
    parts.push(stageGlyph(active, theme));
    parts.push(theme.fg(STAGE_COLOR[active.status] ?? "muted", active.id));
    parts.push(theme.fg("dim", progress(state)));
    if (active.note) parts.push(theme.fg("muted", active.note));
  } else {
    parts.push(theme.fg("dim", progress(state)));
  }

  const decisions = state.needsDecision.length;
  if (decisions > 0)
    parts.push(theme.fg("error", `⚠ ${decisions} to decide`));

  if (state.ci?.nextCheckAt) {
    const rel = relFuture(state.ci.nextCheckAt);
    if (rel) parts.push(theme.fg("dim", `⏲ ${rel}`));
  }

  return truncateToWidth(parts.join(theme.fg("dim", " · ")), Math.max(0, width));
}

/** Multi-line text status for /ship-status (overlay comes later). */
export function textStatus(state: ShipState): string {
  const lines: string[] = [];
  lines.push(`ship: ${state.title ?? state.runId}  [${state.status}]`);
  lines.push("");
  for (const s of state.stages) {
    const g = GLYPH[s.status] ?? "?";
    const model = s.model ? ` (${s.model})` : "";
    const note = s.note ? `  ${s.note}` : "";
    lines.push(`  ${g} ${s.id}${model}${note}`);
  }
  if (state.needsDecision.length) {
    lines.push("");
    lines.push(`⚠ ${state.needsDecision.length} decision(s) pending:`);
    for (const d of state.needsDecision) {
      lines.push(`  · [${d.stage}] ${d.what}`);
      if (d.suggestion) lines.push(`      → suggest: ${d.suggestion}`);
    }
  }
  if (state.pr?.url) {
    lines.push("");
    lines.push(`PR: ${state.pr.url}`);
  }
  return lines.join("\n");
}

function relFuture(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return "now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}
