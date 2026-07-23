/**
 * ship overlay — the per-stage status panel (right-anchored). Two modes:
 *   list     → stage rows (glyph, model, duration, one-liner) + decisions + PR
 *   artifact → scrollable view of a stage's <stage>.md
 *
 * Display-only: re-reads state.json each render (live), reconciles liveness
 * from the runtime, and never writes. Actions that mutate (steer, abort) are
 * returned to the caller via done() so the dialog/confirm flow happens outside
 * the component.
 */

import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  reconcileLiveness,
  readActiveState,
  runDir,
  type ShipState,
  type StageState,
} from "./state.ts";

export type OverlayAction = { kind: "close" } | { kind: "steer" } | { kind: "abort" };

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
const COLOR: Record<string, string> = {
  done: "success",
  running: "accent",
  failed: "error",
  skipped: "dim",
  pending: "dim",
};

function duration(s: StageState): string {
  if (!s.startedAt) return "";
  const end = s.endedAt ? Date.parse(s.endedAt) : Date.now();
  const ms = end - Date.parse(s.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

export class ShipOverlay {
  onClose?: () => void;
  private mode: "list" | "artifact" = "list";
  private selected = 0;
  private scroll = 0;
  private artifactLines: string[] = [];
  private artifactTitle = "";

  constructor(
    private cwd: string,
    private theme: ThemeLike,
    private tui: { requestRender: () => void },
    private done: (a: OverlayAction) => void,
  ) {}

  private state(): ShipState | undefined {
    const raw = readActiveState(this.cwd);
    if (!raw) return undefined;
    return reconcileLiveness(raw).state; // display-only; caller persists elsewhere
  }

  handleInput(data: string): void {
    const st = this.state();
    if (!st) {
      this.done({ kind: "close" });
      return;
    }
    if (this.mode === "artifact") {
      if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
        this.mode = "list";
      } else if (matchesKey(data, "up") || data === "k") {
        this.scroll = Math.max(0, this.scroll - 1);
      } else if (matchesKey(data, "down") || data === "j") {
        this.scroll = Math.min(Math.max(0, this.artifactLines.length - 1), this.scroll + 1);
      }
      this.tui.requestRender();
      return;
    }
    // list mode
    if (matchesKey(data, "escape")) {
      this.done({ kind: "close" });
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(st.stages.length - 1, this.selected + 1);
    } else if (matchesKey(data, "enter")) {
      this.openArtifact(st);
    } else if (data === "s") {
      this.done({ kind: "steer" });
      return;
    } else if (data === "a") {
      this.done({ kind: "abort" });
      return;
    }
    this.tui.requestRender();
  }

  private openArtifact(st: ShipState): void {
    const stage = st.stages[this.selected];
    const file = stage?.artifact ?? `${stage?.id}.md`;
    const path = join(runDir(this.cwd, st.runId), file);
    if (!existsSync(path)) {
      this.artifactTitle = `${stage?.id} — no artifact yet`;
      this.artifactLines = ["(this stage hasn't written an artifact)"];
    } else {
      this.artifactTitle = `${stage?.id} — ${file}`;
      this.artifactLines = readFileSync(path, "utf-8").split("\n");
    }
    this.scroll = 0;
    this.mode = "artifact";
  }

  render(width: number): string[] {
    const t = this.theme;
    const st = this.state();
    if (!st) return [t.fg("muted", "ship: no active run")];
    if (this.mode === "artifact") return this.renderArtifact(width);

    const lines: string[] = [];
    const title = `ship: ${st.title ?? st.runId}`;
    lines.push(t.fg("accent", t.bold(truncateToWidth(title, width))));
    lines.push(t.fg("dim", truncateToWidth(`status: ${st.status}`, width)));
    lines.push("");

    st.stages.forEach((s, i) => {
      const sel = i === this.selected;
      const glyph = t.fg(COLOR[s.status] ?? "muted", GLYPH[s.status] ?? "?");
      const name = (COLOR[s.status] ?? "muted") === "dim"
        ? t.fg("dim", s.id.padEnd(9))
        : t.fg(COLOR[s.status] ?? "muted", s.id.padEnd(9));
      const meta = [s.model, duration(s)].filter(Boolean).join(" ");
      const note = s.note ? `  ${s.note}` : "";
      let row = `${glyph} ${name} ${t.fg("dim", meta.padEnd(10))}${t.fg("muted", note)}`;
      row = truncateToWidth(row, width - 2);
      lines.push(sel ? `${t.fg("accent", "›")} ${row}` : `  ${row}`);
    });

    if (st.needsDecision.length) {
      lines.push("");
      lines.push(t.fg("error", truncateToWidth(`⚠ ${st.needsDecision.length} decision(s) pending:`, width)));
      for (const d of st.needsDecision) {
        lines.push(truncateToWidth(t.fg("error", `  · [${d.stage}] ${d.what}`), width));
        if (d.suggestion)
          lines.push(truncateToWidth(t.fg("dim", `      → ${d.suggestion}`), width));
      }
    }

    if (st.pr?.url) {
      lines.push("");
      lines.push(truncateToWidth(t.fg("mdLink", `PR: ${st.pr.url}`), width));
    }

    lines.push("");
    lines.push(t.fg("dim", truncateToWidth("↑↓ stage · enter artifact · s steer · a abort · esc close", width)));
    return lines;
  }

  private renderArtifact(width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    out.push(t.fg("accent", t.bold(truncateToWidth(this.artifactTitle, width))));
    out.push("");
    const wrapped: string[] = [];
    for (const raw of this.artifactLines) {
      const w = wrapTextWithAnsi(raw, width);
      for (const l of w) wrapped.push(l);
    }
    const visible = wrapped.slice(this.scroll, this.scroll + 24);
    for (const l of visible) out.push(truncateToWidth(l, width));
    out.push("");
    const more = wrapped.length > this.scroll + 24 ? " · ↓ more" : "";
    out.push(t.fg("dim", truncateToWidth(`↑↓ scroll${more} · esc back`, width)));
    return out;
  }

  invalidate(): void {}
}
