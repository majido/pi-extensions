/**
 * ship overlay — the per-stage status panel (top-right, rounded border, 🚀).
 * Two modes:
 *   list     → stage rows (glyph, model, duration, one-liner) + decisions + PR
 *   artifact → scrollable view of a stage's <stage>.md
 *
 * Display-only: re-reads state.json each render (live), reconciles liveness
 * from the runtime, and never writes. Mutating actions (steer, abort) are
 * returned to the caller via done() so dialog/confirm flows happen outside.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
// Theme palette colors (theme-safe). accent reads as the active/blue highlight
// and is distinct from the green `success`; pending is faint gray.
const COLOR: Record<string, string> = {
  done: "success", // green — passed
  running: "accent", // active
  failed: "error", // red
  skipped: "muted", // gray
  pending: "dim", // light gray — not started
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
    const st = this.state();
    if (!st) return this.frame(["no active run"], width, "ship");
    const inner = Math.max(12, width - 4);
    if (this.mode === "artifact") {
      return this.frame(this.artifactBody(inner), width, this.artifactTitle);
    }
    return this.frame(this.listBody(st, inner), width, `ship: ${st.title ?? st.runId}`);
  }

  private listBody(st: ShipState, inner: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    lines.push(t.fg("dim", truncateToWidth(`status: ${st.status}`, inner)));
    lines.push("");

    st.stages.forEach((s, i) => {
      const color = COLOR[s.status] ?? "muted";
      const glyph = t.fg(color, GLYPH[s.status] ?? "?");
      const nameRaw = s.id.padEnd(9);
      const name = s.status === "running" ? t.fg(color, t.bold(nameRaw)) : t.fg(color, nameRaw);
      const meta = [s.model, duration(s)].filter(Boolean).join(" ");
      const note = s.note ? `  ${s.note}` : "";
      const body = `${glyph} ${name} ${t.fg("dim", meta.padEnd(9))}${t.fg("muted", note)}`;
      const sel = i === this.selected;
      const marker = sel ? t.fg("accent", "› ") : "  ";
      lines.push(truncateToWidth(marker + body, inner));
    });

    if (st.needsDecision.length) {
      lines.push("");
      lines.push(t.fg("error", truncateToWidth(`⚠ ${st.needsDecision.length} decision(s) pending:`, inner)));
      for (const d of st.needsDecision) {
        lines.push(truncateToWidth(t.fg("error", `  · [${d.stage}] ${d.what}`), inner));
        if (d.suggestion) lines.push(truncateToWidth(t.fg("dim", `      → ${d.suggestion}`), inner));
      }
    }

    if (st.error) {
      lines.push("");
      lines.push(truncateToWidth(t.fg("error", `error: ${st.error}`), inner));
    }

    if (st.pr?.url) {
      lines.push("");
      lines.push(truncateToWidth(t.fg("mdLink", `PR: ${st.pr.url}`), inner));
    }

    lines.push("");
    lines.push(t.fg("dim", truncateToWidth("↑↓ stage · enter artifact · s steer · a abort · esc close", inner)));
    return lines;
  }

  private artifactBody(inner: number): string[] {
    const t = this.theme;
    const wrapped: string[] = [];
    for (const raw of this.artifactLines) {
      for (const l of wrapTextWithAnsi(raw, inner)) wrapped.push(l);
    }
    const out: string[] = [];
    const visibleLines = wrapped.slice(this.scroll, this.scroll + 22);
    for (const l of visibleLines) out.push(truncateToWidth(l, inner));
    out.push("");
    const more = wrapped.length > this.scroll + 22 ? " · ↓ more" : "";
    out.push(t.fg("dim", truncateToWidth(`↑↓ scroll${more} · esc back`, inner)));
    return out;
  }

  /** Wrap body lines in a rounded border with a 🚀 title in the top edge. */
  private frame(body: string[], width: number, title: string): string[] {
    const t = this.theme;
    const b = (s: string) => t.fg("borderAccent", s);
    const inner = Math.max(12, width - 4);

    const titleText = `🚀 ${title}`;
    const head = `╭─ ${titleText} `;
    const used = visibleWidth(head); // ╭─ + space + title + space
    const fill = Math.max(0, width - used - 1); // -1 for the closing ╮
    const top = b("╭─ ") + t.fg("accent", t.bold(titleText)) + " " + b("─".repeat(fill) + "╮");

    const rows = body.map((line) => {
      const clipped = truncateToWidth(line, inner);
      const pad = Math.max(0, inner - visibleWidth(clipped));
      return b("│ ") + clipped + " ".repeat(pad) + b(" │");
    });

    const bottom = b("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    return [top, ...rows, bottom];
  }

  invalidate(): void {}
}
