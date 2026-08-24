#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PR_STATE_FILE = join(homedir(), ".cache", "pr-check", "state.json");

export function parsePrReference(raw) {
	const input = raw.trim();

	const url = input.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/);
	if (url) {
		return {
			repoFull: `${url[1]}/${url[2]}`,
			repoName: url[2],
			number: Number(url[3]),
		};
	}

	const full = input.match(/^([^/\s]+)\/([^/#\s]+)#(\d+)$/);
	if (full) {
		return {
			repoFull: `${full[1]}/${full[2]}`,
			repoName: full[2],
			number: Number(full[3]),
		};
	}

	const short = input.match(/^([^/#\s]+)[/#](\d+)$/);
	if (short) return { repoName: short[1], number: Number(short[2]) };

	throw new Error("Enter a PR URL, owner/repo#123, repo#123, or repo/123");
}

export function workspaceTitle(ref) {
	return `🦄 ${ref.repoName}#${ref.number}`;
}

export function piSessionName(ref) {
	return `pr check - ${ref.repoName}#${ref.number}`;
}

export async function routePr(raw, actions) {
	const ref = parsePrReference(raw);
	const names = {
		workspace: workspaceTitle(ref),
		session: piSessionName(ref),
	};
	const existing = await actions.findExisting(names.workspace);
	if (existing) {
		await actions.focusExisting(existing);
		return { status: "focused", ref, names };
	}

	await actions.create(ref, names);
	return { status: "created", ref, names };
}

export async function findExistingWorkspace(run, title) {
	const windows = JSON.parse(await run("cmux", ["list-windows", "--json"]));
	for (const window of windows) {
		try {
			const result = JSON.parse(
				await run("cmux", ["workspace", "list", "--window", window.id, "--json"]),
			);
			const workspace = result.workspaces?.find(
				(candidate) => candidate.custom_title === title || candidate.title === title,
			);
			if (workspace) return { windowId: window.id, workspaceId: workspace.id };
		} catch {
			// A window can close while the global scan is in progress; keep looking.
		}
	}
	return undefined;
}

async function run(command, args, options = {}) {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options.cwd,
			env: process.env,
			maxBuffer: 10 * 1024 * 1024,
			timeout: options.timeout ?? 300_000,
		});
		return result.stdout.trim();
	} catch (error) {
		const detail = [error.stderr, error.stdout].filter(Boolean).join("\n").trim();
		throw new Error(`$ ${command} ${args.join(" ")}\n${detail || error.message}`);
	}
}

async function isGitRepo(path) {
	try {
		await access(join(path, ".git"));
		return true;
	} catch {
		return false;
	}
}

async function findLocalRepo(repoName) {
	const root = join(homedir(), "w");
	const direct = join(root, repoName);
	if (await isGitRepo(direct)) return direct;

	const candidates = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = join(root, entry.name, repoName);
		if (await isGitRepo(candidate)) candidates.push(candidate);
	}
	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new Error(`Multiple local clones named ${repoName}: ${candidates.join(", ")}`);
	}
	throw new Error(`Local clone not found under ~/w/: ${repoName}`);
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readState() {
	try {
		return JSON.parse(await readFile(PR_STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

async function recordCheckState(key, entry) {
	const state = await readState();
	state[key] = entry;
	await mkdir(join(homedir(), ".cache", "pr-check"), { recursive: true });
	const temporary = `${PR_STATE_FILE}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
	await rename(temporary, PR_STATE_FILE);
}

async function launcherContext() {
	const identified = JSON.parse(await run("cmux", ["identify", "--json"]));
	const caller = identified.caller ?? identified.focused;
	if (!caller) throw new Error("Could not identify the cmux launcher surface");
	return {
		surface: process.env.CMUX_SURFACE_ID ?? caller.surface_ref,
		workspace: process.env.CMUX_WORKSPACE_ID ?? caller.workspace_ref,
		window: caller.window_ref,
	};
}

async function closeLauncher(launcher) {
	await run("cmux", [
		"close-surface",
		"--surface", launcher.surface,
		"--workspace", launcher.workspace,
		"--window", launcher.window,
	]);
}

async function focusExisting(target, launcher) {
	await run("cmux", ["workspace", "select", target.workspaceId, "--window", target.windowId]);
	await run("cmux", ["focus-window", "--window", target.windowId]);
	await closeLauncher(launcher);
}

async function createPrWorkspace(ref, names, launcher) {
	const repo = await findLocalRepo(ref.repoName);
	const repoFull = ref.repoFull ?? await run(
		"gh",
		["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
		{ cwd: repo, timeout: 30_000 },
	);
	const metadata = JSON.parse(await run("gh", ["api", `repos/${repoFull}/pulls/${ref.number}`], {
		cwd: repo,
		timeout: 30_000,
	}));

	const worktree = await run(
		"treehouse",
		["get", "--lease", "--lease-holder", `pr-check-${repoFull}#${ref.number}`],
		{ cwd: repo },
	);
	let createdWorkspace;
	try {
		try {
			await run("gh", ["pr", "checkout", String(ref.number), "--force"], { cwd: worktree });
		} catch {
			await run("git", ["fetch", `https://github.com/${repoFull}.git`, metadata.head.sha], { cwd: worktree });
			await run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: worktree, timeout: 60_000 });
		}

		const createOutput = await run("cmux", [
			"workspace", "create",
			"--name", names.workspace,
			"--description", metadata.html_url,
			"--cwd", worktree,
			"--command", `exec pi --name ${shellQuote(names.session)}`,
			"--window", launcher.window,
			"--focus", "true",
		]);
		createdWorkspace = createOutput.match(/workspace:\d+/)?.[0];

		const now = new Date().toISOString();
		await recordCheckState(`${repoFull}#${ref.number}`, {
			pickedUpAt: now,
			seenAt: now,
			worktree,
			workspaceRef: createdWorkspace,
			workspaceTitle: names.workspace,
			status: "open",
			title: metadata.title,
			url: metadata.html_url,
		});
	} catch (error) {
		if (createdWorkspace) {
			await run("cmux", ["workspace", "close", createdWorkspace]).catch(() => {});
		}
		await run("treehouse", ["return", worktree, "--force"], { cwd: repo, timeout: 120_000 }).catch(() => {});
		throw error;
	}

	await closeLauncher(launcher);
}

async function promptForReference() {
	const readline = createInterface({ input, output });
	try {
		return await readline.question("PR (URL, owner/repo#123, repo#123, or repo/123): ");
	} finally {
		readline.close();
	}
}

async function main() {
	const launcher = await launcherContext();
	const reference = process.argv.slice(2).join(" ").trim() || await promptForReference();
	if (!reference) {
		await closeLauncher(launcher);
		return;
	}

	await routePr(reference, {
		findExisting: (title) => findExistingWorkspace(run, title),
		focusExisting: (target) => focusExisting(target, launcher),
		create: (ref, names) => createPrWorkspace(ref, names, launcher),
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`Open PR failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
