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

import {
  hyperlink,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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
  underline?: (text: string) => string;
};

// pi's default working spinner (braille), 80ms cadence.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const GLYPH: Record<string, string> = {
  done: "✓", // checkmark — passed
  failed: "●", // red circle — failed
  skipped: "⊘", // skipped
  pending: "○", // empty circle — not started
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
const STATUS_COLOR: Record<string, string> = {
  running: "accent",
  "waiting-ci": "accent",
  paused: "warning",
  done: "success",
  failed: "error",
  aborted: "muted",
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

  private frame = 0;

  constructor(
    private cwd: string,
    private theme: ThemeLike,
    private tui: { requestRender: () => void },
    private done: (a: OverlayAction) => void,
  ) {}

  /** Advance the spinner (called by the overlay's animation interval). */
  tick(): void {
    this.frame = (this.frame + 1) % 100000;
  }

  private spinner(): string {
    return FRAMES[this.frame % FRAMES.length];
  }

  /** Leading indicator for the whole run: spinner while active, else a glyph. */
  private runIndicator(st: ShipState): string {
    const t = this.theme;
    switch (st.status) {
      case "running":
      case "waiting-ci":
        return t.fg("accent", this.spinner());
      case "done":
        return t.fg("success", "✓");
      case "failed":
        return t.fg("error", "✗");
      case "aborted":
        return t.fg("muted", "⊘");
      case "paused":
        return t.fg("warning", "⏸");
      default:
        return t.fg("muted", "•");
    }
  }

  private stageGlyph(status: string): string {
    const t = this.theme;
    if (status === "running") return t.fg("accent", this.spinner());
    return t.fg(COLOR[status] ?? "muted", GLYPH[status] ?? "?");
  }

  /** Short, clickable PR label: "<repo> PR#<n>" via OSC-8 hyperlink. */
  private prLink(st: ShipState, maxWidth: number): string | undefined {
    const url = st.pr?.url;
    if (!url) return undefined;
    let repoShort = st.pr?.repo?.split("/").pop();
    let num = st.pr?.number;
    if (!repoShort || !num) {
      const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
      if (m) {
        repoShort ??= m[1];
        num ??= Number(m[2]);
      }
    }
    let text = `${repoShort ?? "PR"}${num ? ` PR#${num}` : ""}`;
    if (visibleWidth(text) > maxWidth) text = num ? `PR#${num}` : "PR";
    const t = this.theme;
    const styled = t.underline
      ? t.underline(t.fg("mdLink", text))
      : t.fg("mdLink", text);
    return hyperlink(styled, url);
  }

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
    if (!st) return this.boxed(["no active run"], width, "ship");
    const inner = Math.max(12, width - 4);
    if (this.mode === "artifact") {
      return this.boxed(this.artifactBody(inner), width, this.artifactTitle);
    }
    return this.boxed(this.listBody(st, inner), width, `ship · ${st.runId}`);
  }

  private listBody(st: ShipState, inner: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // Header line: <status animation> <status text> - <linked PR>
    const indicator = this.runIndicator(st);
    const statusText = t.fg(STATUS_COLOR[st.status] ?? "muted", st.status);
    const link = this.prLink(st, inner - visibleWidth(st.status) - 5);
    lines.push(`${indicator} ${statusText}${link ? `${t.fg("dim", " - ")}${link}` : ""}`);
    lines.push("");

    st.stages.forEach((s, i) => {
      const color = COLOR[s.status] ?? "muted";
      const glyph = this.stageGlyph(s.status);
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
  private boxed(body: string[], width: number, title: string): string[] {
    const t = this.theme;
    const b = (s: string) => t.fg("borderAccent", s);
    const inner = Math.max(12, width - 4);

    const titleText = truncateToWidth(`🚀 ${title}`, Math.max(4, width - 6));
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
