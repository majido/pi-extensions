/**
 * Branch Worktree Extension
 *
 * Creates a git worktree from a base branch, optionally opening it in a sibling cmux workspace.
 * Auto-detects origin/main or origin/master as the base branch.
 *
 * Commands:
 *   /branch <name> [--base ref] [--worktree-dir dir] — create branch + worktree only
 *   /branch-and-split <name> [--base ref] [--worktree-dir dir] [--command cmd] — also open cmux workspace
 *   /branch-done [--no-retro] [--keep-branch] — run retro, clean up worktree (& workspace if /branch-and-split was used), exit
 *
 * Env: PI_BRANCH_BASE, PI_BRANCH_WORKTREE_DIR, PI_BRANCH_AGENT_COMMAND
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_WORKTREE_DIR = process.env.PI_BRANCH_WORKTREE_DIR ?? ".worktree";
const DEFAULT_AGENT_COMMAND = process.env.PI_BRANCH_AGENT_COMMAND ?? "exec pi";
const CMUX_MARKER_FILE = "branch-worktree-cmux";

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

const LEADING_EMOJI = /^((?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\uFE0E)?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\uFE0E)?)*)+)/u;

function parseWorkspaceName(listWorkspacesOutput: string, workspaceRef: string | null | undefined, fallback: string): string {
	if (!workspaceRef) return fallback;

	const workspaceLine = listWorkspacesOutput.split("\n").find((line) => {
		const normalized = line.replace(/^\*\s+/, "").trimStart();
		return normalized.startsWith(`${workspaceRef} `);
	});
	if (!workspaceLine) return fallback;

	return workspaceLine
		.replace(/^\*\s+/, "")
		.trimStart()
		.slice(workspaceRef.length)
		.replace(/\s+\[selected\]\s*$/, "")
		.trim() || fallback;
}

function leadingEmojiPrefix(workspaceName: string): string {
	const match = workspaceName.trimStart().match(LEADING_EMOJI);
	return match?.[1] ? `${match[1]} ` : "";
}

function humanizeBranchName(branch: string): string {
	const lastSegment = branch.split("/").filter(Boolean).pop() ?? branch;
	return lastSegment
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim() || branch;
}

function workspaceNameForBranch(branch: string, currentWorkspaceName: string): string {
	return `${leadingEmojiPrefix(currentWorkspaceName)}${humanizeBranchName(branch)}`.trim();
}

type WorkspaceGroupList = {
	groups?: Array<{
		ref?: string;
		member_workspace_refs?: string[];
	}>;
};

function findWorkspaceGroup(groupListJson: string, workspaceRef: string | null | undefined): string | null {
	if (!workspaceRef) return null;

	const groupList = JSON.parse(groupListJson) as WorkspaceGroupList;
	return groupList.groups?.find((group) => group.member_workspace_refs?.includes(workspaceRef))?.ref ?? null;
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

	type BranchDoneCleanup = {
		info: WorktreeInfo | null;
		keepBranch: boolean;
		retroMessage?: string;
		retroStarted: boolean;
	};

	let pendingBranchDoneCleanup: BranchDoneCleanup | null = null;

	async function detectWorktreeInfo(cwd: string): Promise<WorktreeInfo | null> {
		const toplevel = await run("git", ["rev-parse", "--show-toplevel"], cwd);
		const gitCommonDir = await run("git", ["rev-parse", "--git-common-dir"], cwd);
		const resolvedCommon = resolve(toplevel, gitCommonDir);

		// If git-common-dir equals .git under toplevel, we're not in a worktree
		if (resolvedCommon === resolve(toplevel, ".git")) return null;

		// Main repo root is the parent of the .git common dir
		const mainRepoRoot = resolve(resolvedCommon, "..");
		const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);

		// Detect cmux workspace for this worktree — only if /branch-and-split created one
		// (marker file in the worktree's git dir stores the created workspace ref)
		let workspaceRef: string | null = null;
		let windowRef: string | null = null;
		const gitDir = await run("git", ["rev-parse", "--absolute-git-dir"], cwd);
		const markerPath = join(gitDir, CMUX_MARKER_FILE);
		if (existsSync(markerPath)) {
			const markedWorkspaceRef = readFileSync(markerPath, "utf8").trim();
			try {
				const identifyRaw = await run("cmux", ["identify"], cwd);
				const identify = JSON.parse(identifyRaw) as {
					caller?: { window_ref?: string; workspace_ref?: string };
					focused?: { window_ref?: string; workspace_ref?: string };
				};
				const currentWorkspaceRef = identify.caller?.workspace_ref ?? identify.focused?.workspace_ref ?? null;
				if (markedWorkspaceRef && currentWorkspaceRef === markedWorkspaceRef) {
					windowRef = identify.caller?.window_ref ?? identify.focused?.window_ref ?? null;
					workspaceRef = currentWorkspaceRef;
				}
			} catch {
				// cmux not available, that's fine
			}
		}

		return { worktreePath: toplevel, mainRepoRoot, branch, workspaceRef, windowRef };
	}

	function retroFilePath(branch: string): string {
		const now = new Date();
		const date = now.toISOString().slice(0, 10);
		const slug = sanitizeBranchForPath(branch).slice(0, 40);
		return join(homedir(), ".agents", "retros", `${date}-${slug}.md`);
	}

	async function cleanupBranchDone(ctx: ExtensionContext, request: BranchDoneCleanup): Promise<void> {
		const { info, keepBranch } = request;

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

			// Close cmux workspace only if this is the sole pane (safe to close)
			if (workspaceRef && windowRef) {
				try {
					const panesOutput = await run("cmux", ["list-panes", "--workspace", workspaceRef, "--window", windowRef], mainRepoRoot);
					const paneCount = panesOutput.split("\n").filter((line) => line.trim().startsWith("pane:") || line.trim().startsWith("* pane:")).length;
					if (paneCount <= 1) {
						await run("cmux", ["close-workspace", "--workspace", workspaceRef, "--window", windowRef], mainRepoRoot);
						// If we reach here, cmux didn't kill us — shut down gracefully
					} else {
						ctx.ui.notify(`Workspace has ${paneCount} panes — skipping workspace close`, "info");
					}
				} catch (e) {
					ctx.ui.notify(`cmux cleanup failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
				}
			}
		}

		ctx.shutdown();
	}

	pi.on("agent_start", (event) => {
		const pending = pendingBranchDoneCleanup;
		if (pending && pending.retroMessage === event.prompt) {
			pending.retroStarted = true;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingBranchDoneCleanup?.retroStarted) return;

		const request = pendingBranchDoneCleanup;
		pendingBranchDoneCleanup = null;
		ctx.ui.notify("Session retro complete; cleaning up branch...", "info");
		await cleanupBranchDone(ctx, request);
	});

	pi.registerCommand("branch-done", {
		description: "Run session retro, clean up worktree & cmux workspace, and exit",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const flags = rawArgs.trim().split(/\s+/).filter(Boolean);
			const noRetro = flags.includes("--no-retro");
			const keepBranch = flags.includes("--keep-branch");

			if (pendingBranchDoneCleanup) {
				ctx.ui.notify("branch-done cleanup is already pending; wait for the retro to finish.", "warning");
				return;
			}

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

			if (noRetro) {
				await cleanupBranchDone(ctx, { info, keepBranch, retroStarted: false });
				return;
			}

			const retroPath = retroFilePath(branchLabel);
			const retroDir = resolve(retroPath, "..");
			await mkdir(retroDir, { recursive: true });

			const retroMessage = `${RETRO_PROMPT}\nWrite the retro to: ${retroPath}`;
			pendingBranchDoneCleanup = { info, keepBranch, retroMessage, retroStarted: false };

			try {
				pi.sendUserMessage(retroMessage, { deliverAs: "followUp" });
				ctx.ui.notify("Running session retro; cleanup will continue after it finishes.", "info");
			} catch (e) {
				pendingBranchDoneCleanup = null;
				ctx.ui.notify(`Failed to start session retro: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	type BranchCreateResult = {
		repoRoot: string;
		worktreePath: string;
		branch: string;
		base: string;
	};

	async function createBranchWorktree(parsed: ParsedArgs, ctx: ExtensionContext): Promise<BranchCreateResult> {
		const { branch } = parsed;

		// Resolve the main repo root, not the worktree toplevel, to avoid nesting worktrees
		const toplevel = await run("git", ["rev-parse", "--show-toplevel"], ctx.cwd);
		const gitCommonDir = await run("git", ["rev-parse", "--git-common-dir"], ctx.cwd);
		const resolvedCommon = resolve(toplevel, gitCommonDir);
		const repoRoot = resolvedCommon === resolve(toplevel, ".git")
			? toplevel
			: resolve(resolvedCommon, "..");
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

		return { repoRoot, worktreePath, branch, base };
	}

	function isInvalidBranchName(branch: string): boolean {
		return branch.startsWith("-") || branch.includes("..") || branch.includes("~") || branch.includes("^") || /\s/.test(branch);
	}

	pi.registerCommand("branch", {
		description: "Create a git worktree branch (no cmux workspace)",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const parsed = parseArgs(rawArgs);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /branch <branch-name> [--base origin/main] [--worktree-dir .worktree]",
					"error",
				);
				return;
			}

			if (isInvalidBranchName(parsed.branch)) {
				ctx.ui.notify(`Invalid branch name: ${parsed.branch}`, "error");
				return;
			}

			try {
				const { branch, worktreePath } = await createBranchWorktree(parsed, ctx);
				ctx.ui.notify(`Created ${branch} at ${worktreePath}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("branch-and-split", {
		description: "Create a git worktree branch and open it in a sibling cmux workspace",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const parsed = parseArgs(rawArgs);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /branch-and-split <branch-name> [--base origin/main] [--worktree-dir .worktree] [--command pi]",
					"error",
				);
				return;
			}

			const { branch, command } = parsed;
			if (isInvalidBranchName(branch)) {
				ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
				return;
			}

			try {
				const { repoRoot, worktreePath } = await createBranchWorktree(parsed, ctx);

				let workspaceCreated = false;
				try {
					const identifyRaw = await run("cmux", ["identify"], repoRoot);
					const identify = JSON.parse(identifyRaw) as {
						caller?: { window_ref?: string; workspace_ref?: string };
						focused?: { window_ref?: string; workspace_ref?: string };
					};
					const windowRef = identify.caller?.window_ref ?? identify.focused?.window_ref;
					const currentWorkspaceRef = identify.caller?.workspace_ref ?? identify.focused?.workspace_ref;
					if (!windowRef) throw new Error("Could not determine current cmux window");

					const workspaceList = await run("cmux", ["list-workspaces", "--window", windowRef], repoRoot);
					const currentWorkspaceName = parseWorkspaceName(workspaceList, currentWorkspaceRef, branch);
					const workspaceName = workspaceNameForBranch(branch, currentWorkspaceName);
					const currentWorkspaceGroup = await run("cmux", ["workspace-group", "list", "--json"], repoRoot)
						.then((groupList) => findWorkspaceGroup(groupList, currentWorkspaceRef))
						.catch(() => null);

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

					// Record the created workspace so /branch-done knows it may close it
					try {
						const newWorkspaceRef = await run("cmux", ["current-workspace", "--window", windowRef], repoRoot);
						const worktreeGitDir = await run("git", ["rev-parse", "--absolute-git-dir"], worktreePath);
						writeFileSync(join(worktreeGitDir, CMUX_MARKER_FILE), `${newWorkspaceRef}\n`);

						if (currentWorkspaceGroup) {
							await run("cmux", ["workspace-group", "add", "--group", currentWorkspaceGroup, "--workspace", newWorkspaceRef], repoRoot);
						}
					} catch (error) {
						ctx.ui.notify(`Post-workspace setup failed (branch-done won't auto-close this workspace): ${error instanceof Error ? error.message : String(error)}`, "warning");
					}
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
