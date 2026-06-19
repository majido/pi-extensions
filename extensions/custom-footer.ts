/**
 * Custom Footer — replaces the default footer with a compact, single-line layout.
 *
 * Line 1: repo|branch *⇣⇡                   62% [========  ] $0.12 model·thinking
 * Line 2: (extension statuses, e.g. MCP)
 *
 * Context bar color graduates: muted → warning → error.
 * Git indicators: * dirty, ⇣ behind, ⇡ ahead, ⑂ worktree separator.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";

// ── Helpers ──────────────────────────────────────────────────────────

interface GitExtra {
  repo: string | null;
  isWorktree: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
}

function getGitExtra(cwd: string): GitExtra {
  try {
    const opts = {
      encoding: "utf-8" as const,
      timeout: 3000,
      cwd,
      stdio: ["ignore", "pipe", "ignore"] as const,
    };
    const gitDir = execSync("git rev-parse --git-dir", opts).trim();
    const gitCommonDir = execSync("git rev-parse --git-common-dir", opts).trim();
    const isWorktree = gitDir !== gitCommonDir;

    let repo: string | null;
    if (isWorktree) {
      // In a worktree, git-common-dir points to the main repo's .git
      // e.g. /path/to/main-repo/.git — parent dir is the real repo name
      const commonAbs = execSync(
        `cd "${gitCommonDir}" && pwd`, opts,
      ).trim();
      repo = commonAbs.replace(/\/\.git$/, "").split("/").pop() ?? null;
    } else {
      const toplevel = execSync("git rev-parse --show-toplevel", opts).trim();
      repo = toplevel ? toplevel.split("/").pop() ?? null : null;
    }

    // Parse status in one shot
    const statusRaw = execSync(
      "git status --porcelain=v2 --branch 2>/dev/null",
      opts,
    ).trim();
    let dirty = false;
    let ahead = 0;
    let behind = 0;
    for (const line of statusRaw.split("\n")) {
      if (line.startsWith("# branch.ab ")) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) {
          ahead = parseInt(m[1], 10);
          behind = parseInt(m[2], 10);
        }
      } else if (!line.startsWith("#")) {
        dirty = true;
      }
    }

    return { repo, isWorktree, dirty, ahead, behind };
  } catch {
    return { repo: null, isWorktree: false, dirty: false, ahead: 0, behind: 0 };
  }
}

// ── Context Bar ──────────────────────────────────────────────────────

const BAR_WIDTH = 10;

// Theme token gradient — each = colored by its 10% band
// Within each band, later slots use bold for intensification
const BAR_SLOTS: { color: string; bold: boolean }[] = [
  { color: "success", bold: false },  //  0-10%
  { color: "success", bold: false },  // 10-20%
  { color: "success", bold: true },   // 20-30%  ─┐ bold ramp
  { color: "muted",   bold: false },  // 30-40%
  { color: "muted",   bold: true },   // 40-50%  ─┐
  { color: "accent",  bold: false },  // 50-60%
  { color: "accent",  bold: true },   // 60-70%  ─┐
  { color: "warning", bold: false },  // 70-80%
  { color: "warning", bold: true },   // 80-90%  ─┐
  { color: "error",   bold: true },   // 90-100%
];

function renderContextBar(
  percent: number | null,
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
): string {
  const pct = percent ?? 0;
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  let filledStr = "";
  for (let i = 0; i < filled; i++) {
    const slot = BAR_SLOTS[i];
    const ch = slot.bold ? theme.bold("=") : "=";
    filledStr += theme.fg(slot.color, ch);
  }

  const bar =
    theme.fg("dim", "[") +
    filledStr +
    " ".repeat(empty) +
    theme.fg("dim", "]");

  const label = percent !== null ? `${Math.round(pct)}%` : "?";
  return bar + theme.fg("dim", label);
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let gitExtra: GitExtra = { repo: null, isWorktree: false };
  pi.on("session_start", async (_event, ctx) => {
    gitExtra = getGitExtra(ctx.cwd);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => {
        gitExtra = getGitExtra(ctx.cwd);
        tui.requestRender();
      });

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // ── Stats ──
          let totalCost = 0;
          for (const e of ctx.sessionManager.getEntries()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              totalCost += m.usage.cost.total;
            }
          }

          const usage = ctx.getContextUsage();
          const pct = usage?.percent ?? null;

          // ═══════════════════════════════════════════════════════
          // Line 1:  model · thinking [==========]62%    repo(branch)
          // ═══════════════════════════════════════════════════════

          // Left: repo|branch *⇣⇡
          const branch = footerData.getGitBranch();
          const repo = gitExtra.repo;
          const wt = gitExtra.isWorktree;
          let left = "";
          if (repo && branch) {
            let marks = "";
            if (gitExtra.dirty) marks += "*";
            if (gitExtra.behind) marks += `⇣${gitExtra.behind > 1 ? gitExtra.behind : ""}`;
            if (gitExtra.ahead) marks += `⇡${gitExtra.ahead > 1 ? gitExtra.ahead : ""}`;
            const suffix = marks ? " " + marks : "";
            const sep = wt ? " ⑂ " : "|";
            left =
              theme.fg("dim", `${repo}${sep}`) +
              theme.fg("accent", theme.bold(branch)) +
              theme.fg("dim", suffix);
          } else if (repo) {
            left = theme.fg("dim", repo);
          }

          // Right: context bar + cost + model·thinking
          const modelId = ctx.model?.id ?? "no-model";
          const thinking = pi.getThinkingLevel();
          const hasReasoning = (ctx.model as any)?.reasoning;
          const thinkSuffix = hasReasoning
            ? thinking === "off"
              ? "·thinking off"
              : `·${thinking}`
            : "";
          const costStr = totalCost ? `$${totalCost.toFixed(2)}` : "$0";
          const bar = renderContextBar(pct, theme);
          const right =
            bar + " " + theme.fg("dim", `${costStr} ${modelId}${thinkSuffix}`);

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);
          const gap = width - lw - rw;
          const line1 = left + " ".repeat(Math.max(1, gap)) + right;

          const lines = [truncateToWidth(line1, width)];

          // ═══════════════════════════════════════════════════════
          // Line 2:  extension statuses (MCP, etc.)
          // ═══════════════════════════════════════════════════════
          const statuses = footerData.getExtensionStatuses();
          if (statuses.size > 0) {
            const sorted = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, t]) =>
                t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim(),
              );
            lines.push(truncateToWidth(sorted.join(" "), width));
          }

          return lines;
        },
      };
    });
  });
}
