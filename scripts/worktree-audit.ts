#!/usr/bin/env -S npx -y tsx
/**
 * worktree-audit.ts
 *
 * Standalone facts-only collector for git worktree cleanup decisions. Reports,
 * per worktree: branch, last-commit age, dirty/local-only-commit state, PR
 * status (via gh), and whether the path is actively in use by any running
 * process (via lsof). Makes no decisions — just emits JSON for a skill/agent
 * to reason over.
 *
 * Usage:
 *   npx tsx scripts/worktree-audit.ts [--repo <path>] [--stale-days 14]
 *     [--pr-limit 300] [--format json|table]
 *
 * Run from anywhere inside the repo (main checkout or any worktree).
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve, sep } from "node:path";

type RawWorktree = {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	locked: boolean;
	lockedReason: string | null;
	prunable: boolean;
	prunableReason: string | null;
};

type PrInfo = {
	number: number;
	state: string;
	merged: boolean;
	mergedAt: string | null;
	draft: boolean;
	url: string;
	title: string;
};

type WorktreeReport = {
	path: string;
	branch: string | null;
	detached: boolean;
	main: boolean;
	locked: boolean;
	lockedReason: string | null;
	prunable: boolean;
	prunableReason: string | null;
	head: {
		sha: string | null;
		short: string | null;
		date: string | null;
		ageDays: number | null;
	};
	git: {
		dirty: boolean | null;
		untrackedCount: number | null;
		upstream: string | null;
		unpushedCommits: number | null;
		aheadOfDefault: number | null;
		behindDefault: number | null;
		localOnlyCommits: number | null;
	};
	pr: PrInfo | null;
	inUse: boolean;
	suggestion: string;
	reasons: string[];
};

type Args = {
	repo: string;
	staleDays: number;
	prLimit: number;
	format: "json" | "table";
};

function parseArgs(argv: string[]): Args {
	const args: Args = { repo: process.cwd(), staleDays: 14, prLimit: 300, format: "json" };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		const [key, inlineValue] = token.split(/=(.*)/s);
		const value = inlineValue ?? argv[i + 1];
		const consume = inlineValue === undefined;
		switch (key) {
			case "--repo":
				args.repo = value;
				if (consume) i += 1;
				break;
			case "--stale-days":
				args.staleDays = Number(value);
				if (consume) i += 1;
				break;
			case "--pr-limit":
				args.prLimit = Number(value);
				if (consume) i += 1;
				break;
			case "--format":
				if (value === "json" || value === "table") args.format = value;
				if (consume) i += 1;
				break;
			default:
				break;
		}
	}
	return args;
}

function run(cmd: string, cmdArgs: string[], cwd: string): string {
	return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryRun(cmd: string, cmdArgs: string[], cwd: string): string | null {
	try {
		return run(cmd, cmdArgs, cwd);
	} catch {
		return null;
	}
}

function resolveMainRepoRoot(cwd: string): string {
	const toplevel = run("git", ["rev-parse", "--show-toplevel"], cwd);
	const gitCommonDir = run("git", ["rev-parse", "--git-common-dir"], cwd);
	const resolvedCommon = resolve(toplevel, gitCommonDir);
	if (resolvedCommon === resolve(toplevel, ".git")) return toplevel;
	return resolve(resolvedCommon, "..");
}

function parsePorcelain(output: string): RawWorktree[] {
	const blocks = output
		.split(/\n\n+/)
		.map((b) => b.trim())
		.filter(Boolean);
	const result: RawWorktree[] = [];

	for (const block of blocks) {
		const lines = block.split("\n");
		const wtLine = lines.find((l) => l.startsWith("worktree "));
		if (!wtLine) continue;

		let head: string | null = null;
		let branch: string | null = null;
		let detached = false;
		let bare = false;
		let locked = false;
		let lockedReason: string | null = null;
		let prunable = false;
		let prunableReason: string | null = null;

		for (const line of lines) {
			if (line.startsWith("HEAD ")) head = line.slice(5).trim();
			else if (line.startsWith("branch ")) branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
			else if (line === "detached") detached = true;
			else if (line === "bare") bare = true;
			else if (line === "locked" || line.startsWith("locked ")) {
				locked = true;
				lockedReason = line === "locked" ? null : line.slice("locked ".length).trim();
			} else if (line === "prunable" || line.startsWith("prunable ")) {
				prunable = true;
				prunableReason = line === "prunable" ? null : line.slice("prunable ".length).trim();
			}
		}

		if (bare) continue;
		result.push({
			path: wtLine.slice("worktree ".length).trim(),
			head,
			branch,
			detached,
			locked,
			lockedReason,
			prunable,
			prunableReason,
		});
	}

	return result;
}

async function detectDefaultBase(repoRoot: string, warnings: string[]): Promise<string | null> {
	tryRun("git", ["fetch", "--prune", "--quiet"], repoRoot);
	for (const candidate of ["origin/main", "origin/master"]) {
		if (tryRun("git", ["rev-parse", "--verify", candidate], repoRoot) !== null) return candidate;
	}
	warnings.push("Could not detect default base branch (no origin/main or origin/master); ahead/behind counts unavailable.");
	return null;
}

function getPrMap(repoRoot: string, limit: number, warnings: string[]): Map<string, PrInfo> {
	const map = new Map<string, PrInfo>();
	const output = tryRun(
		"gh",
		["pr", "list", "--state", "all", "--json", "number,headRefName,state,mergedAt,url,title,isDraft", "--limit", String(limit)],
		repoRoot,
	);
	if (output === null) {
		warnings.push("gh pr list failed (not authenticated, no network, or not a GitHub repo); PR status unavailable for all worktrees.");
		return map;
	}
	let prs: Array<{ number: number; headRefName: string; state: string; mergedAt: string | null; url: string; title: string; isDraft: boolean }>;
	try {
		prs = JSON.parse(output);
	} catch {
		warnings.push("Could not parse gh pr list output; PR status unavailable.");
		return map;
	}
	for (const pr of prs) {
		const existing = map.get(pr.headRefName);
		if (existing && existing.number >= pr.number) continue;
		map.set(pr.headRefName, {
			number: pr.number,
			state: pr.state,
			merged: pr.state === "MERGED" || Boolean(pr.mergedAt),
			mergedAt: pr.mergedAt,
			draft: pr.isDraft,
			url: pr.url,
			title: pr.title,
		});
	}
	return map;
}

function getLiveCwds(warnings: string[]): Set<string> {
	const user = process.env.USER ?? userInfo().username;
	const output = tryRun("lsof", ["-u", user, "-a", "-d", "cwd", "-Fn"], process.cwd());
	if (output === null) {
		warnings.push("lsof unavailable; in-use detection disabled (all worktrees treated as not in use).");
		return new Set();
	}
	const cwds = new Set<string>();
	for (const line of output.split("\n")) {
		if (!line.startsWith("n")) continue;
		const path = line.slice(1);
		try {
			cwds.add(realpathSync.native(path));
		} catch {
			cwds.add(path);
		}
	}
	return cwds;
}

function isPathInUse(path: string, liveCwds: Set<string>): boolean {
	let real: string;
	try {
		real = realpathSync.native(path);
	} catch {
		return false; // path doesn't exist, can't be "in use"
	}
	for (const cwd of liveCwds) {
		if (cwd === real || cwd.startsWith(real + sep)) return true;
	}
	return false;
}

function classify(e: Omit<WorktreeReport, "suggestion" | "reasons">, staleDays: number): { suggestion: string; reasons: string[] } {
	const reasons: string[] = [];

	if (e.main) return { suggestion: "keep_main", reasons: ["primary repository worktree"] };
	if (e.inUse) return { suggestion: "in_use", reasons: ["active process cwd detected under this path (lsof)"] };
	if (e.prunable) {
		reasons.push("worktree directory missing on disk" + (e.prunableReason ? ` (${e.prunableReason})` : ""));
		return { suggestion: "prune", reasons };
	}

	const hasLocalWork =
		Boolean(e.git.dirty) || (e.git.untrackedCount ?? 0) > 0 || (e.git.localOnlyCommits ?? 0) > 0;

	if (e.git.upstream === null && (e.git.aheadOfDefault ?? 0) > 0) {
		reasons.push(`no upstream configured; ${e.git.aheadOfDefault} commit(s) exist only locally`);
	} else if ((e.git.unpushedCommits ?? 0) > 0) {
		reasons.push(`${e.git.unpushedCommits} commit(s) not pushed to upstream`);
	}
	if (e.git.dirty) reasons.push("uncommitted changes in working tree");
	if ((e.git.untrackedCount ?? 0) > 0) reasons.push(`${e.git.untrackedCount} untracked file(s)`);

	if (e.pr?.merged) {
		if (hasLocalWork) {
			reasons.unshift(`PR #${e.pr.number} merged, but local work found — review before deleting`);
			return { suggestion: "review_merged_has_work", reasons };
		}
		return { suggestion: "safe_delete", reasons: [`PR #${e.pr.number} merged`, ...reasons] };
	}

	if (e.pr && e.pr.state === "CLOSED") {
		reasons.unshift(`PR #${e.pr.number} closed without merging`);
		return { suggestion: hasLocalWork ? "review_closed_has_work" : "review_pr_closed", reasons };
	}

	if (e.pr && e.pr.state === "OPEN") {
		reasons.unshift(`PR #${e.pr.number}${e.pr.draft ? " (draft)" : ""} open`);
		return { suggestion: "keep_pr_open", reasons };
	}

	if (hasLocalWork) {
		reasons.unshift("no PR found");
		return { suggestion: "review_no_pr_has_work", reasons };
	}
	if (e.head.ageDays !== null && e.head.ageDays > staleDays) {
		return { suggestion: "review_stale_no_pr", reasons: [`no PR found; no commits in ${e.head.ageDays}d`] };
	}
	return { suggestion: "review_recent_no_pr", reasons: ["no PR found; recent activity, no local changes"] };
}

function printTable(reports: WorktreeReport[]) {
	const rows = reports.map((r) => [
		r.suggestion,
		r.branch ?? "(detached)",
		r.head.ageDays !== null ? `${r.head.ageDays}d` : "?",
		r.git.dirty === null ? "?" : r.git.dirty ? "dirty" : "clean",
		r.pr ? `#${r.pr.number} ${r.pr.state}` : "-",
		r.inUse ? "IN_USE" : "",
		r.path,
	]);
	const header = ["SUGGESTION", "BRANCH", "AGE", "STATE", "PR", "", "PATH"];
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
	const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
	console.log(fmt(header));
	for (const row of rows) console.log(fmt(row));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const warnings: string[] = [];

	const repoRoot = resolveMainRepoRoot(resolve(args.repo));
	const rawWorktrees = parsePorcelain(run("git", ["worktree", "list", "--porcelain"], repoRoot));
	const defaultBase = await detectDefaultBase(repoRoot, warnings);
	const prMap = getPrMap(repoRoot, args.prLimit, warnings);
	const liveCwds = getLiveCwds(warnings);

	const reports: WorktreeReport[] = rawWorktrees.map((raw, index) => {
		const exists = existsSync(raw.path);
		const sha = raw.head;
		const short = sha ? sha.slice(0, 7) : null;

		const dateStr = sha ? tryRun("git", ["show", "-s", "--format=%cI", sha], repoRoot) : null;
		const ageDays = dateStr ? Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000) : null;

		let upstream: string | null = null;
		let unpushedCommits: number | null = null;
		let aheadOfDefault: number | null = null;
		let behindDefault: number | null = null;

		if (raw.branch) {
			upstream = tryRun("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${raw.branch}@{u}`], repoRoot);
			if (upstream !== null) {
				const count = tryRun("git", ["rev-list", "--count", `${raw.branch}@{u}..${raw.branch}`], repoRoot);
				unpushedCommits = count !== null ? Number(count) : null;
			}
			if (defaultBase) {
				const leftRight = tryRun("git", ["rev-list", "--left-right", "--count", `${defaultBase}...${raw.branch}`], repoRoot);
				if (leftRight) {
					const [behind, ahead] = leftRight.split(/\s+/).map(Number);
					behindDefault = behind;
					aheadOfDefault = ahead;
				}
			}
		}

		let dirty: boolean | null = null;
		let untrackedCount: number | null = null;
		if (exists && !raw.prunable) {
			const status = tryRun("git", ["-C", raw.path, "status", "--porcelain"], repoRoot);
			if (status !== null) {
				const lines = status.split("\n").filter(Boolean);
				untrackedCount = lines.filter((l) => l.startsWith("??")).length;
				dirty = lines.some((l) => !l.startsWith("??"));
			}
		}

		const localOnlyCommits = upstream === null ? (aheadOfDefault ?? 0) : (unpushedCommits ?? 0);

		const base: Omit<WorktreeReport, "suggestion" | "reasons"> = {
			path: raw.path,
			branch: raw.branch,
			detached: raw.detached,
			main: index === 0,
			locked: raw.locked,
			lockedReason: raw.lockedReason,
			prunable: raw.prunable || !exists,
			prunableReason: raw.prunableReason,
			head: { sha, short, date: dateStr, ageDays },
			git: { dirty, untrackedCount, upstream, unpushedCommits, aheadOfDefault, behindDefault, localOnlyCommits },
			pr: raw.branch ? (prMap.get(raw.branch) ?? null) : null,
			inUse: exists ? isPathInUse(raw.path, liveCwds) : false,
		};

		const { suggestion, reasons } = classify(base, args.staleDays);
		return { ...base, suggestion, reasons };
	});

	if (args.format === "table") {
		printTable(reports);
		if (warnings.length) console.error("\nWarnings:\n" + warnings.map((w) => `- ${w}`).join("\n"));
		return;
	}

	console.log(JSON.stringify({ generatedAt: new Date().toISOString(), repoRoot, defaultBase, warnings, worktrees: reports }, null, 2));
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack ?? err.message : String(err));
	process.exit(1);
});
