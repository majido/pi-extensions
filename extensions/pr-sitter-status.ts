/**
 * pr-sitter status widget — shows the active PR sitter below the editor, in the
 * same area as the "Scheduled Prompts" widget. Single compact line:
 *
 *   PR Sitter: #39 iris • watching • next check in 3m (last one 43s ago)
 *
 * If more than one sitter is active (rare), the most urgent is shown with a
 * "+N more" suffix. Refreshes every 30s so relative times stay live.
 * Display-only; the state file is the source of truth.
 * Disable with: pi --no-extension pr-sitter-status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".cache", "pr-sitter");
const WIDGET_ID = "pr-sitter";
const TICK_MS = 30_000;
const TERMINAL_LINGER_MS = 5 * 60_000;

type Sitter = {
  repo?: string;
  prShort?: string;
  pr?: number;
  url?: string;
  state?: string;
  status?: string;
  needsDecision?: unknown[];
  lastCheckAt?: string | null;
  nextCheckAt?: string | null;
};

const STATES: Record<string, { color: string; rank: number; label: string }> = {
  "needs-decision": { color: "error", rank: 100, label: "needs decision" },
  "ci-failure": { color: "error", rank: 90, label: "ci failure" },
  "changes-requested": { color: "warning", rank: 80, label: "changes requested" },
  fixing: { color: "accent", rank: 70, label: "fixing" },
  "checks-running": { color: "warning", rank: 60, label: "checks running" },
  "awaiting-approval": { color: "muted", rank: 50, label: "awaiting approval" },
  created: { color: "accent", rank: 40, label: "created" },
  approved: { color: "success", rank: 20, label: "approved" },
  merged: { color: "success", rank: 10, label: "merged" },
  closed: { color: "dim", rank: 5, label: "closed" },
};

function readSitters(): Sitter[] {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Sitter[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8")) as Sitter);
    } catch {
      // skip half-written file
    }
  }
  return out;
}

const isTerminal = (s: Sitter) => s.state === "merged" || s.state === "closed";

function isStale(s: Sitter): boolean {
  if (!isTerminal(s)) return false;
  const t = s.lastCheckAt ? Date.parse(s.lastCheckAt) : NaN;
  return Number.isNaN(t) || Date.now() - t > TERMINAL_LINGER_MS;
}

function activeSitters(): Sitter[] {
  return readSitters()
    .filter((s) => !isStale(s))
    .sort((a, b) => (STATES[b.state ?? ""]?.rank ?? 0) - (STATES[a.state ?? ""]?.rank ?? 0));
}

function rel(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return s <= 1 ? "<1m" : `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function relPast(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : rel(Date.now() - t);
}

function relFuture(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return t - Date.now() <= 0 ? "now" : rel(t - Date.now());
}

function lineText(
  s: Sitter,
  theme: {
    fg: (k: string, t: string) => string;
    bold: (t: string) => string;
    underline: (t: string) => string;
  },
): string {
  const meta = STATES[s.state ?? ""] ?? { color: "muted", label: s.state ?? "?" };
  const name = s.prShort ?? s.repo ?? "pr";
  const sep = theme.fg("dim", " • ");

  // "iris #68" rendered as a clickable link when a URL is known: use the
  // markdown link color + underline so it reads as a link even in terminals
  // without OSC 8 support. Otherwise fall back to the state color.
  const nameText = `${name} #${s.pr ?? "?"}`;
  const nameSegment = s.url
    ? hyperlink(theme.fg("mdLink", theme.underline(nameText)), s.url)
    : theme.fg(meta.color, nameText);

  const parts: string[] = [
    nameSegment,
    theme.fg(meta.color, meta.label),
  ];

  const decide = Array.isArray(s.needsDecision) ? s.needsDecision.length : 0;
  if (decide > 0) parts.push(theme.fg("error", `${decide} to decide`));

  const last = relPast(s.lastCheckAt);
  const lastSuffix = last ? theme.fg("dim", ` (last one ${last} ago)`) : "";

  if (s.status === "paused") {
    parts.push(theme.fg("muted", "paused") + lastSuffix);
  } else if (isTerminal(s)) {
    if (last) parts.push(theme.fg("dim", `last check ${last} ago`));
  } else {
    const next = relFuture(s.nextCheckAt);
    if (next) {
      parts.push(theme.fg("dim", next === "now" ? "next check now" : `next check in ${next}`) + lastSuffix);
    } else if (last) {
      parts.push(theme.fg("dim", `last check ${last} ago`));
    }
  }

  return theme.fg("accent", theme.bold("PR Sitter:")) + " " + parts.join(sep);
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let savedCtx: any;

  const render = (ctx: any) => {
    savedCtx = ctx;
    const sitters = activeSitters();
    if (sitters.length === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    const top = sitters[0];
    const more = sitters.length - 1;

    ctx.ui.setWidget(
      WIDGET_ID,
      (_tui: any, theme: any) => ({
        render: (width: number) => {
          let line = lineText(top, theme);
          if (more > 0) line += theme.fg("dim", ` +${more} more`);
          // Never emit a line wider than the viewport or the TUI crashes.
          return [truncateToWidth(line, Math.max(0, width))];
        },
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

  pi.on("session_start", async (_event, ctx) => {
    // Bind to the fresh ctx for this session. Any previously captured ctx is
    // stale after a session replacement / reload and must not be reused.
    savedCtx = ctx;
    render(ctx);

    stopTimer();
    timer = setInterval(() => {
      if (!savedCtx) return;
      try {
        render(savedCtx);
      } catch {
        // ctx went stale between session_shutdown and the next session_start;
        // drop it and wait for the next session_start to rebind.
        savedCtx = undefined;
        stopTimer();
      }
    }, TICK_MS);
    (timer as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", async () => {
    // The ctx for the outgoing session is about to become stale.
    stopTimer();
    savedCtx = undefined;
  });
}
