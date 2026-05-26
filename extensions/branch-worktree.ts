/**
 * Branch Worktree Extension
 *
 * Creates a git worktree from a base branch and opens it in a sibling cmux workspace.
 * Auto-detects origin/main or origin/master as the base branch.
 *
 * Commands:
 *   /branch <name> [--base ref] [--worktree-dir dir] [--command cmd]
 *   /done [--no-retro] [--keep-branch] — run retro, clean up worktree & workspace, exit
 *
 * Env: PI_BRANCH_BASE, PI_BRANCH_WORKTREE_DIR, PI_BRANCH_AGENT_COMMAND
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_WORKTREE_DIR = process.env.PI_BRANCH_WORKTREE_DIR ?? ".worktree";
const DEFAULT_AGENT_COMMAND = process.env.PI_BRANCH_AGENT_COMMAND ?? "exec pi";

type ParsedArgs = {
	branch: string;
	base: string | null;
	worktreeRoot: string;
	command: string;
};

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeBranchForPath(branch: string): string {
	return branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

function parseArgs(raw: string): ParsedArgs | null {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;

	let base: string | null = null;
	let worktreeRoot = DEFAULT_WORKTREE_DIR;
	let command = DEFAULT_AGENT_COMMAND;
	const branchParts: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--base" && tokens[i + 1]) {
			base = tokens[++i];
		} else if (token.startsWith("--base=")) {
			base = token.slice("--base=".length);
		} else if (token === "--worktree-dir" && tokens[i + 1]) {
			worktreeRoot = tokens[++i];
		} else if (token.startsWith("--worktree-dir=")) {
			worktreeRoot = token.slice("--worktree-dir=".length);
		} else if (token === "--command" && tokens[i + 1]) {
			command = tokens.slice(++i).join(" ");
			break;
		} else if (token.startsWith("--command=")) {
			command = [token.slice("--command=".length), ...tokens.slice(i + 1)].join(" ");
			break;
		} else {
			branchParts.push(token);
		}
	}

	const branch = branchParts.join(" ").trim();
	if (!branch) return null;
	return { branch, base, worktreeRoot, command };
}

function parseSelectedWorkspaceName(listWorkspacesOutput: string, fallback: string): string {
	const selected = listWorkspacesOutput.split("\n").find((line) => line.trimStart().startsWith("*"));
	if (!selected) return fallback;

	return selected
		.replace(/^\*\s+workspace:\d+\s+/, "")
		.replace(/\s+\[selected\]\s*$/, "")
		.trim() || fallback;
}

async function detectDefaultBase(
	exec: (command: string, args: string[], cwd: string, timeout?: number) => Promise<string>,
	cwd: string,
): Promise<string> {
	const envBase = process.env.PI_BRANCH_BASE;
	if (envBase) return envBase;

	for (const candidate of ["origin/main", "origin/master"]) {
		const result = await exec("git", ["rev-parse", "--verify", candidate], cwd).catch(() => null);
		if (result !== null) return candidate;
	}

	throw new Error("Could not detect default base branch. Neither origin/main nor origin/master found. Use --base to specify.");
}

const RETRO_PROMPT = `Produce a structured retrospective of this session. Be direct, skip praise, cite evidence.

For every finding, quote the specific turn (\`> "..."\`) and give a concrete next-time action.

**Dimensions** (omit any with no issues):

- **Skill & tool selection** — missed skill loads, wrong tool, sequential calls that should have been parallel, unnecessary bash vs. dedicated tools.
- **Assistant performance** — wrong assumptions, hallucinated paths/APIs, premature edits, insufficient verification, over-engineering.
- **Prompt quality** — ambiguity, missing context, missing file refs, missing constraints.
- **Task scoping** — chunks too large/vague, missed batching opportunities.
- **Back-and-forth** — avoidable clarification loops, corrections that signal ambiguous original ask.
- **Verification** — missing test/build steps, re-do cycles from weak review.
- **Agent sandbox or permission friction** — tasks or tool calls blocked by lacking permission, API calls that failed due to insufficient permissions, and steps taken (or missed) to resolve them.
- **Rules to add/update** — recurring patterns worth codifying in project or global AGENTS.md.

**End with:**

- **Top 3 wins for next session** — ranked, highest-leverage first.
- **Persist** — write the retro content to the file path provided in the tool call.
`;

export default function branchWorktreeExtension(pi: ExtensionAPI) {
	async function run(command: string, args: string[], cwd: string, timeout = 60_000): Promise<string> {
		const result = await pi.exec(command, args, { cwd, timeout });
		if (result.code !== 0) {
			throw new Error(
				[`$ ${command} ${args.map(shellQuote).join(" ")}`, result.stdout, result.stderr]
					.filter(Boolean)
					.join("\n"),
			);
		}
		return result.stdout.trim();
	}

	type WorktreeInfo = {
		worktreePath: string;
		mainRepoRoot: string;
		branch: string;
		workspaceRef: string | null;
		windowRef: string | null;
	};

	async function detectWorktreeInfo(cwd: string): Promise<WorktreeInfo | null> {
		const toplevel = await run("git", ["rev-parse", "--show-toplevel"], cwd);
		const gitCommonDir = await run("git", ["rev-parse", "--git-common-dir"], cwd);
		const resolvedCommon = resolve(toplevel, gitCommonDir);

		// If git-common-dir equals .git under toplevel, we're not in a worktree
		if (resolvedCommon === resolve(toplevel, ".git")) return null;

		// Main repo root is the parent of the .git common dir
		const mainRepoRoot = resolve(resolvedCommon, "..");
		const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);

		// Detect cmux workspace for this worktree
		let workspaceRef: string | null = null;
		let windowRef: string | null = null;
		try {
			const identifyRaw = await run("cmux", ["identify", "--no-caller"], cwd);
			const identify = JSON.parse(identifyRaw) as {
				focused?: { window_ref?: string; workspace_ref?: string };
			};
			windowRef = identify.focused?.window_ref ?? null;
			workspaceRef = identify.focused?.workspace_ref ?? null;
		} catch {
			// cmux not available, that's fine
		}

		return { worktreePath: toplevel, mainRepoRoot, branch, workspaceRef, windowRef };
	}

	function retroFilePath(branch: string): string {
		const now = new Date();
		const date = now.toISOString().slice(0, 10);
		const slug = sanitizeBranchForPath(branch).slice(0, 40);
		return join(homedir(), ".agents", "retros", `${date}-${slug}.md`);
	}

	pi.registerCommand("done", {
		description: "Run session retro, clean up worktree & cmux workspace, and exit",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const flags = rawArgs.trim().split(/\s+/).filter(Boolean);
			const noRetro = flags.includes("--no-retro");
			const keepBranch = flags.includes("--keep-branch");

			let info: WorktreeInfo | null = null;
			try {
				info = await detectWorktreeInfo(ctx.cwd);
			} catch {
				// not in a git repo, proceed without cleanup
			}

			const branchLabel = info?.branch ?? "session";

			// Confirm before proceeding
			const summary = info
				? `Branch: ${info.branch}\nWorktree: ${info.worktreePath}${keepBranch ? "\n(keeping branch)" : ""}`
				: "Not in a worktree — will run retro only.";
			const confirmed = await ctx.ui.confirm(
				"Done — clean up and exit?",
				`${summary}\n\n${noRetro ? "Skipping retro." : "Will run session retro first."}`,
			);
			if (!confirmed) return;

			// Step 1: Run retro
			if (!noRetro) {
				const retroPath = retroFilePath(branchLabel);
				const retroDir = resolve(retroPath, "..");
				await mkdir(retroDir, { recursive: true });

				ctx.ui.notify("Running session retro...", "info");

				const retroMessage = `${RETRO_PROMPT}\nWrite the retro to: ${retroPath}`;
				await ctx.sendUserMessage(retroMessage, { deliverAs: "followUp" });
				await ctx.waitForIdle();
			}

			// Step 2: Clean up worktree, branch, and workspace
			if (info) {
				const { worktreePath, mainRepoRoot, branch, workspaceRef, windowRef } = info;

				// Remove worktree first (while our process is still alive)
				try {
					await run("git", ["worktree", "remove", "--force", worktreePath], mainRepoRoot, 120_000);
					ctx.ui.notify(`Removed worktree: ${worktreePath}`, "info");
				} catch (e) {
					ctx.ui.notify(`Worktree removal failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
				}

				// Delete local branch (unless --keep-branch)
				if (!keepBranch) {
					try {
						await run("git", ["branch", "-D", branch], mainRepoRoot);
						ctx.ui.notify(`Deleted branch: ${branch}`, "info");
					} catch {
						// Branch may already be deleted or merged, ignore
					}
				}

				// Close cmux workspace last (this kills panes including pi)
				if (workspaceRef && windowRef) {
					try {
						await run("cmux", ["close-workspace", "--workspace", workspaceRef, "--window", windowRef], mainRepoRoot);
						// If we reach here, cmux didn't kill us — shut down gracefully
					} catch (e) {
						ctx.ui.notify(`cmux cleanup failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
					}
				}
			}

			// Step 3: Shut down pi (fallback if cmux close didn't terminate us)
			ctx.shutdown();
		},
	});

	pi.registerCommand("branch", {
		description: "Create a git worktree branch and open it in a sibling cmux workspace",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const parsed = parseArgs(rawArgs);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /branch <branch-name> [--base origin/main] [--worktree-dir .worktree] [--command pi]",
					"error",
				);
				return;
			}

			const { branch, command } = parsed;
			if (branch.startsWith("-") || branch.includes("..") || branch.includes("~") || branch.includes("^") || /\s/.test(branch)) {
				ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
				return;
			}

			try {
				const repoRoot = await run("git", ["rev-parse", "--show-toplevel"], ctx.cwd);
				const worktreeRoot = resolve(repoRoot, parsed.worktreeRoot);
				const worktreePath = join(worktreeRoot, sanitizeBranchForPath(branch));

				await run("git", ["fetch", "--prune", "--all"], repoRoot, 180_000);

				const base = parsed.base ?? await detectDefaultBase(run, repoRoot);

				ctx.ui.notify(`Creating ${branch} from ${base}...`, "info");
				mkdirSync(worktreeRoot, { recursive: true });

				if (existsSync(worktreePath)) {
					throw new Error(`Worktree directory already exists: ${worktreePath}`);
				}

				const existingBranch = await pi.exec("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
					cwd: repoRoot,
					timeout: 10_000,
				});
				if (existingBranch.code === 0) {
					throw new Error(`Branch already exists: ${branch}`);
				}

				await run("git", ["rev-parse", "--verify", base], repoRoot);
				await run("git", ["worktree", "add", "-b", branch, worktreePath, base], repoRoot, 180_000);

				let workspaceCreated = false;
				try {
					const identifyRaw = await run("cmux", ["identify", "--no-caller"], repoRoot);
					const identify = JSON.parse(identifyRaw) as { focused?: { window_ref?: string } };
					const windowRef = identify.focused?.window_ref;
					if (!windowRef) throw new Error("Could not determine current cmux window");

					const workspaceList = await run("cmux", ["list-workspaces"], repoRoot);
					const workspaceName = parseSelectedWorkspaceName(workspaceList, branch);

					await run(
						"cmux",
						[
							"new-workspace",
							"--window",
							windowRef,
							"--name",
							workspaceName,
							"--cwd",
							worktreePath,
							"--command",
							command,
							"--focus",
							"true",
						],
						repoRoot,
						60_000,
					);
					workspaceCreated = true;
				} catch (cmuxError) {
					await run("git", ["worktree", "remove", "--force", worktreePath], repoRoot).catch(() => {});
					await pi.exec("git", ["branch", "-D", branch], { cwd: repoRoot, timeout: 10_000 }).catch(() => {});
					throw cmuxError;
				}

				if (workspaceCreated) {
					ctx.ui.notify(`Opened ${branch} in ${worktreePath}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("worktree-status", {
		description: "Show current worktree info (branch, paths, cmux workspace)",
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => {
			try {
				const info = await detectWorktreeInfo(ctx.cwd);
				if (!info) {
					ctx.ui.notify("Not in a git worktree", "info");
					return;
				}
				const lines = [
					`Branch: ${info.branch}`,
					`Worktree: ${info.worktreePath}`,
					`Main repo: ${info.mainRepoRoot}`,
					info.workspaceRef ? `Workspace: ${info.workspaceRef}` : "Workspace: n/a",
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
