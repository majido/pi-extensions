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
  branch: string | null;
  isWorktree: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
}

function displayCwd(ctx: { cwd: string; sessionManager?: { getCwd?: () => string } }): string {
  return ctx.sessionManager?.getCwd?.() || ctx.cwd || process.env.CMUX_AGENT_LAUNCH_CWD || process.cwd();
}

// Drop a common user/namespace prefix from branch names for display.
// e.g. "mvalipour/fix-mcp-schema" → "fix-mcp-schema"
const BRANCH_PREFIXES = ["mvalipour/"];
function shortenBranch(branch: string): string {
  for (const p of BRANCH_PREFIXES) {
    if (branch.startsWith(p)) return branch.slice(p.length);
  }
  return branch;
}

// Compact model id: strip provider-ish "claude-" prefix for display.
function shortenModelId(id: string): string {
  return id.replace(/^claude-/, "");
}

// Chess-piece glyphs for thinking level, ascending by rank.
// minimal ♙ · low ♟ · medium ♞ · high ♛ · xhigh(max) ♚
const THINK_GLYPH: Record<string, string> = {
  minimal: "♙",
  low: "♟",
  medium: "♞",
  high: "♛",
  xhigh: "♚",
};
function thinkingGlyph(level: string): string {
  return THINK_GLYPH[level] ?? level;
}

// Cost: drop cents once value exceeds $1.
function formatCost(cost: number): string {
  if (!cost) return "$0";
  return cost > 1 ? `$${Math.round(cost)}` : `$${cost.toFixed(2)}`;
}

// Parse an MCP extension status like "MCP: 2/6 servers" → { used, total }.
function parseMcpStatus(text: string): { used: number; total: number } | null {
  const m = text.match(/MCP:\s*(\d+)(?:\/(\d+))?/i);
  if (!m) return null;
  const used = parseInt(m[1], 10);
  const total = m[2] ? parseInt(m[2], 10) : used;
  return { used, total };
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
    let branch: string | null = null;
    let dirty = false;
    let ahead = 0;
    let behind = 0;
    for (const line of statusRaw.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        const head = line.slice("# branch.head ".length).trim();
        branch = head && head !== "(detached)" ? head : "detached";
      } else if (line.startsWith("# branch.ab ")) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) {
          ahead = parseInt(m[1], 10);
          behind = parseInt(m[2], 10);
        }
      } else if (!line.startsWith("#")) {
        dirty = true;
      }
    }

    return { repo, branch, isWorktree, dirty, ahead, behind };
  } catch {
    return { repo: null, branch: null, isWorktree: false, dirty: false, ahead: 0, behind: 0 };
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
  let gitExtra: GitExtra = { repo: null, branch: null, isWorktree: false, dirty: false, ahead: 0, behind: 0 };
  let gitExtraCwd = "";
  let gitExtraRefreshedAt = 0;

  function refreshGitExtra(ctx: { cwd: string; sessionManager?: { getCwd?: () => string } }, maxAgeMs = 1000): GitExtra {
    const cwd = displayCwd(ctx);
    const now = Date.now();
    if (cwd !== gitExtraCwd || now - gitExtraRefreshedAt > maxAgeMs) {
      gitExtra = getGitExtra(cwd);
      gitExtraCwd = cwd;
      gitExtraRefreshedAt = now;
    }
    return gitExtra;
  }

  pi.on("session_start", async (_event, ctx) => {
    gitExtra = refreshGitExtra(ctx, 0);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => {
        gitExtra = refreshGitExtra(ctx, 0);
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
          // Resolve branch from git directly so worktrees don't inherit the main checkout's branch.
          gitExtra = refreshGitExtra(ctx);
          const rawBranch = gitExtra.branch ?? footerData.getGitBranch();
          const branch = rawBranch ? shortenBranch(rawBranch) : rawBranch;
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

          // Right: context bar + cost + model · thinking · MCP
          const modelId = shortenModelId(ctx.model?.id ?? "no-model");
          const thinking = pi.getThinkingLevel();
          const hasReasoning = (ctx.model as any)?.reasoning;
          const thinkSuffix = hasReasoning
            ? thinking === "off"
              ? ""
              : ` ${thinkingGlyph(thinking)}`
            : "";
          const costStr = formatCost(totalCost);
          const bar = renderContextBar(pct, theme);

          // MCP status: pull out of extension statuses, show inline only when used.
          const statuses = footerData.getExtensionStatuses();
          let mcpSuffix = "";
          const mcpRaw = statuses.get("mcp");
          if (mcpRaw) {
            const parsed = parseMcpStatus(mcpRaw.replace(/\x1b\[[0-9;]*m/g, ""));
            if (parsed && parsed.used > 0) {
              mcpSuffix = ` · MCP ${parsed.used}/${parsed.total}`;
            }
          }

          const right =
            bar + " " + theme.fg("dim", `${costStr} ${modelId}${thinkSuffix}${mcpSuffix}`);

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);
          const gap = width - lw - rw;
          const line1 = left + " ".repeat(Math.max(1, gap)) + right;

          const lines = [truncateToWidth(line1, width)];

          // ═══════════════════════════════════════════════════════
          // Line 2:  extension statuses (MCP, etc.)
          // ═══════════════════════════════════════════════════════
          // MCP is rendered inline on line 1; exclude it here.
          const otherStatuses = Array.from(statuses.entries()).filter(
            ([k]) => k !== "mcp",
          );
          if (otherStatuses.length > 0) {
            const sorted = otherStatuses
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
