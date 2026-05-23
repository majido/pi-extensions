import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
			command = tokens[++i];
		} else if (token.startsWith("--command=")) {
			command = token.slice("--command=".length);
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
			if (branch.startsWith("-") || branch.includes("..") || branch.includes("~") || branch.includes("^")) {
				ctx.ui.notify(`Refusing suspicious branch name: ${branch}`, "error");
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

				const existingBranch = await pi.exec("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
					cwd: repoRoot,
					timeout: 10_000,
				});
				if (existingBranch.code === 0) {
					throw new Error(`Branch already exists: ${branch}`);
				}

				await run("git", ["rev-parse", "--verify", base], repoRoot);
				await run("git", ["worktree", "add", "-b", branch, worktreePath, base], repoRoot, 180_000);

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

				ctx.ui.notify(`Opened ${branch} in ${worktreePath} as cmux workspace "${workspaceName}"`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
