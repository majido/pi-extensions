/**
 * PR Review Inbox Extension
 *
 * Picks up PRs assigned to me for review and opens each in a dedicated cmux
 * workspace: pi agent (auto-starting the review) in the left pane, the PR
 * files view in a browser pane on the right. Worktrees are leased from the
 * `treehouse` pool and returned on /review-done.
 *
 * Commands:
 *   /review-inbox [--auto] [--dry-run]  — scan review requests, pick up new PRs
 *   /review-inbox --baseline            — mark all current requests as seen (no pickup)
 *   /review-pickup <ref>                — force pickup of one PR; ref may be a URL,
 *                                         owner/repo#n, repo#n (allowlist lookup),
 *                                         or #n / n (repo of current directory)
 *   /review-pr <url>                    — start reviewing a PR in the current session
 *   /review-done                        — return worktree, close review workspace, exit
 *
 * Scheduled trigger (pi-schedule-prompt):
 *   schedule_prompt add, schedule: "0 0,15,30,45 8-18 * * 1-5", prompt: "/review-inbox --auto"
 *
 * Env:
 *   PI_REVIEW_REPOS         comma-separated nameWithOwner allowlist
 *   PI_REVIEW_MAX_AGE_DAYS  recency cutoff on updatedAt (default 14)
 *   PI_REVIEW_AUTO_LIMIT    max pickups per --auto run (default 3)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_FILE = join(homedir(), ".cache", "pr-review", "state.json");
const REPO_BASE = join(homedir(), "w");

const DEFAULT_REPOS = [
	"hopper-org/iris",
	"hopper-org/travel-tech-lab",
	"hopper-org/lodging-support-agent",
];

const SKILL_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"skills",
	"pr-review",
	"SKILL.md",
);

type Pr = {
	number: number;
	title: string;
	url: string;
	updatedAt: string;
	repoFull: string; // owner/repo
	repoName: string;
	author: string;
};

type StateEntry = {
	pickedUpAt?: string;
	seenAt: string;
	worktree?: string;
	workspaceRef?: string;
	status: "seen" | "open" | "done";
	title?: string;
	url?: string;
};

type State = Record<string, StateEntry>;

function allowedRepos(): string[] {
	const env = process.env.PI_REVIEW_REPOS;
	if (env) return env.split(",").map((r) => r.trim()).filter(Boolean);
	return DEFAULT_REPOS;
}

function maxAgeDays(): number {
	return Number(process.env.PI_REVIEW_MAX_AGE_DAYS) || 14;
}

function autoLimit(): number {
	return Number(process.env.PI_REVIEW_AUTO_LIMIT) || 3;
}

function readState(): State {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
	} catch {
		return {};
	}
}

function writeState(state: State): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function prKey(pr: Pr): string {
	return `${pr.repoFull}#${pr.number}`;
}

function shellQuoteSingle(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildKickoff(prUrl: string): string {
	return [
		`Read the pr-review skill at ${SKILL_PATH} and follow it to review this PR:`,
		prUrl,
		"",
		"The worktree you are in is already checked out at the PR head.",
		"At the end, ask whether the user considers the review done and wants the review workspace cleaned up.",
		"If they confirm, call the review_done tool so it queues /review-done automatically.",
	].join("\n");
}

export default function prReviewInboxExtension(pi: ExtensionAPI) {
	async function run(command: string, args: string[], cwd: string, timeout = 60_000): Promise<string> {
		const result = await pi.exec(command, args, { cwd, timeout });
		if (result.code !== 0) {
			throw new Error(
				[`$ ${command} ${args.join(" ")}`, result.stdout, result.stderr].filter(Boolean).join("\n"),
			);
		}
		return result.stdout.trim();
	}

	// ── Discovery ─────────────────────────────────────────────────────────────

	async function fetchReviewRequests(cwd: string): Promise<Pr[]> {
		const raw = await run(
			"gh",
			[
				"search", "prs",
				"--review-requested=@me",
				"--state=open",
				"--sort=updated",
				"--limit", "50",
				"--json", "number,title,url,repository,updatedAt,author",
			],
			cwd,
			60_000,
		);
		const parsed = JSON.parse(raw) as Array<{
			number: number;
			title: string;
			url: string;
			updatedAt: string;
			repository: { name: string; nameWithOwner: string };
			author?: { login?: string };
		}>;

		const cutoff = Date.now() - maxAgeDays() * 24 * 60 * 60 * 1000;
		const repos = allowedRepos();

		return parsed
			.map((p) => ({
				number: p.number,
				title: p.title,
				url: p.url,
				updatedAt: p.updatedAt,
				repoFull: p.repository.nameWithOwner,
				repoName: p.repository.name,
				author: p.author?.login ?? "unknown",
			}))
			.filter((p) => repos.includes(p.repoFull))
			.filter((p) => new Date(p.updatedAt).getTime() >= cutoff);
	}

	// ── Pickup ────────────────────────────────────────────────────────────────

	async function pickupPr(pr: Pr, ctx: ExtensionContext): Promise<StateEntry> {
		const repoRoot = join(REPO_BASE, pr.repoName);
		if (!existsSync(repoRoot)) {
			throw new Error(`Repo not cloned locally: ${repoRoot}`);
		}

		// 1. Lease a worktree from the treehouse pool (grows the pool if needed)
		const leaseHolder = `pr-review-${pr.repoName}#${pr.number}`;
		const worktree = await run(
			"treehouse",
			["get", "--lease", "--lease-holder", leaseHolder],
			repoRoot,
			300_000,
		);

		// 2. Check out the PR head (detached fallback if the branch is busy elsewhere)
		try {
			await run("gh", ["pr", "checkout", String(pr.number), "--force"], worktree, 300_000);
		} catch {
			// `origin` can be the user's fork, where the upstream PR ref is unavailable.
			// Fetch the PR's immutable head SHA from its canonical repository instead.
			const headSha = await run(
				"gh",
				["api", `repos/${pr.repoFull}/pulls/${pr.number}`, "--jq", ".head.sha"],
				worktree,
				30_000,
			);
			await run("git", ["fetch", `https://github.com/${pr.repoFull}.git`, headSha], worktree, 300_000);
			await run("git", ["checkout", "--detach", "FETCH_HEAD"], worktree, 60_000);
		}

		// 3. Create the two-pane cmux workspace: pi (auto-review) | PR browser
		const kickoff = buildKickoff(pr.url);
		const layout = JSON.stringify({
			direction: "horizontal",
			split: 0.5,
			children: [
				{ pane: { surfaces: [{ type: "terminal", command: `exec pi ${shellQuoteSingle(kickoff)}` }] } },
				{ pane: { surfaces: [{ type: "browser", url: `${pr.url}/files` }] } },
			],
		});

		const workspaceName = `🔍 ${pr.repoName}#${pr.number}`;
		const createArgs = [
			"workspace", "create",
			"--name", workspaceName,
			"--cwd", worktree,
			"--layout", layout,
			"--focus", "false",
		];

		// Add to the caller's workspace group when there is one
		try {
			const identify = JSON.parse(await run("cmux", ["identify"], repoRoot)) as {
				caller?: { workspace_ref?: string };
				focused?: { workspace_ref?: string };
			};
			const currentWorkspaceRef = identify.caller?.workspace_ref ?? identify.focused?.workspace_ref;
			if (currentWorkspaceRef) {
				const groupList = JSON.parse(await run("cmux", ["workspace-group", "list", "--json"], repoRoot)) as {
					groups?: Array<{ ref?: string; member_workspace_refs?: string[] }>;
				};
				const group = groupList.groups?.find((g) => g.member_workspace_refs?.includes(currentWorkspaceRef))?.ref;
				if (group) createArgs.push("--group", group, "--group-placement", "end");
			}
		} catch {
			// no cmux group context, fine
		}

		let workspaceRef: string | undefined;
		try {
			const created = await run("cmux", createArgs, repoRoot, 60_000);
			workspaceRef = created.match(/workspace:\d+/)?.[0];
		} catch (error) {
			// Roll back the lease so the worktree isn't stranded
			await pi.exec("treehouse", ["return", worktree, "--force"], { cwd: repoRoot, timeout: 120_000 }).catch(() => {});
			throw error;
		}

		return {
			pickedUpAt: new Date().toISOString(),
			seenAt: new Date().toISOString(),
			worktree,
			workspaceRef,
			status: "open",
			title: pr.title,
			url: pr.url,
		};
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("review-inbox", {
		description: "Scan PRs awaiting my review and open review workspaces for new ones",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const flags = rawArgs.trim().split(/\s+/).filter(Boolean);
			const auto = flags.includes("--auto");
			const dryRun = flags.includes("--dry-run");
			const baseline = flags.includes("--baseline");

			let prs: Pr[];
			try {
				prs = await fetchReviewRequests(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(`gh search failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const state = readState();
			const newPrs = prs.filter((pr) => !state[prKey(pr)]);

			if (baseline) {
				for (const pr of prs) {
					state[prKey(pr)] = { seenAt: new Date().toISOString(), status: "seen", title: pr.title, url: pr.url };
				}
				writeState(state);
				ctx.ui.notify(`Baseline: marked ${prs.length} review request(s) as seen.`, "info");
				return;
			}

			if (newPrs.length === 0) {
				if (!auto) ctx.ui.notify(`No new review requests (${prs.length} total in scope).`, "info");
				return;
			}

			const listing = newPrs
				.map((pr) => `- ${prKey(pr)} — ${pr.title} (@${pr.author})`)
				.join("\n");

			if (dryRun) {
				ctx.ui.notify(`New review requests (dry run):\n${listing}`, "info");
				return;
			}

			let toPickup = newPrs;
			if (auto) {
				toPickup = newPrs.slice(0, autoLimit());
			} else {
				const confirmed = await ctx.ui.confirm(
					`Pick up ${newPrs.length} PR(s) for review?`,
					`${listing}\n\nEach gets a treehouse worktree + cmux workspace (pi | PR browser).`,
				);
				if (!confirmed) return;
			}

			const picked: string[] = [];
			const failed: string[] = [];
			for (const pr of toPickup) {
				try {
					state[prKey(pr)] = await pickupPr(pr, ctx);
					picked.push(prKey(pr));
				} catch (error) {
					failed.push(`${prKey(pr)}: ${error instanceof Error ? error.message : String(error)}`);
				}
				writeState(state);
			}

			const summary = [
				picked.length ? `Picked up: ${picked.join(", ")}` : null,
				failed.length ? `Failed:\n${failed.join("\n")}` : null,
				auto && newPrs.length > toPickup.length
					? `${newPrs.length - toPickup.length} more pending (auto limit ${autoLimit()}); run /review-inbox to pick up.`
					: null,
			].filter(Boolean).join("\n");
			if (summary) ctx.ui.notify(summary, failed.length ? "warning" : "info");
		},
	});

	async function resolvePrRef(arg: string, cwd: string): Promise<{ repoFull: string; number: number } | null> {
		// Full URL: https://github.com/owner/repo/pull/123
		const urlMatch = arg.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
		if (urlMatch) return { repoFull: urlMatch[1], number: Number(urlMatch[2]) };

		// owner/repo#123
		const fullMatch = arg.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
		if (fullMatch) return { repoFull: fullMatch[1], number: Number(fullMatch[2]) };

		// repo#123 — resolve repo name against the allowlist
		const shortMatch = arg.match(/^([^/#\s]+)#(\d+)$/);
		if (shortMatch) {
			const repoFull = allowedRepos().find((r) => r.split("/")[1] === shortMatch[1]);
			if (!repoFull) {
				throw new Error(`Repo "${shortMatch[1]}" not in allowlist (${allowedRepos().join(", ")}). Use owner/repo#${shortMatch[2]}.`);
			}
			return { repoFull, number: Number(shortMatch[2]) };
		}

		// #123 or 123 — use the current directory's repo
		const bareMatch = arg.match(/^#?(\d+)$/);
		if (bareMatch) {
			const repoFull = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd, 30_000);
			return { repoFull, number: Number(bareMatch[1]) };
		}

		return null;
	}

	pi.registerCommand("review-pickup", {
		description: "Force pickup of one PR for review (url, owner/repo#123, repo#123, or #123 in a repo dir)",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const arg = rawArgs.trim();
			let ref: { repoFull: string; number: number } | null;
			try {
				ref = await resolvePrRef(arg, ctx.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!ref) {
				ctx.ui.notify("Usage: /review-pickup <pr-url | owner/repo#123 | repo#123 | #123>", "error");
				return;
			}
			const { repoFull, number } = ref;

			try {
				const raw = await run(
					"gh",
					["api", `repos/${repoFull}/pulls/${number}`, "--jq", "{title: .title, html_url: .html_url, updated_at: .updated_at, author: .user.login}"],
					ctx.cwd,
					30_000,
				);
				const meta = JSON.parse(raw) as { title: string; html_url: string; updated_at: string; author: string };
				const pr: Pr = {
					number,
					title: meta.title,
					url: meta.html_url,
					updatedAt: meta.updated_at,
					repoFull,
					repoName: repoFull.split("/")[1],
					author: meta.author,
				};

				const state = readState();
				state[prKey(pr)] = await pickupPr(pr, ctx);
				writeState(state);
				ctx.ui.notify(`Picked up ${prKey(pr)} — workspace ready.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("review-pr", {
		description: "Start reviewing a PR in this session (follows the pr-review skill)",
		getArgumentCompletions: () => null,
		handler: async (rawArgs, ctx) => {
			const url = rawArgs.trim();
			if (!url) {
				ctx.ui.notify("Usage: /review-pr <pr-url>", "error");
				return;
			}
			pi.sendUserMessage(buildKickoff(url), { deliverAs: "followUp" });
		},
	});

	pi.registerTool({
		name: "review_inbox",
		label: "Scan PR review inbox",
		description:
			"Queue /review-inbox to scan PRs awaiting my review and open review workspaces for new ones. Pass auto=true for unattended pickup (no confirmation, capped at PI_REVIEW_AUTO_LIMIT), dryRun=true to only list new PRs, or baseline=true to mark all current requests as seen without pickup. Use this to run the review inbox from an agent or scheduled prompt.",
		promptSnippet: "Queue /review-inbox to pick up PRs awaiting review",
		promptGuidelines: [
			"Use review_inbox when asked to run the PR review inbox or when a scheduled /review-inbox prompt fires; pass auto=true for unattended runs.",
		],
		parameters: Type.Object({
			auto: Type.Optional(Type.Boolean()),
			dryRun: Type.Optional(Type.Boolean()),
			baseline: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params) {
			const flags = [
				params.auto ? "--auto" : null,
				params.dryRun ? "--dry-run" : null,
				params.baseline ? "--baseline" : null,
			].filter(Boolean).join(" ");
			const cmd = `/review-inbox${flags ? ` ${flags}` : ""}`;
			pi.sendUserMessage(cmd, { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: `Queued ${cmd} to scan the PR review inbox.` }],
			};
		},
	});

	pi.registerTool({
		name: "review_done",
		label: "Finish PR review",
		description: "Queue /review-done to return the PR review worktree and close its workspace after the user explicitly confirms that the review is done.",
		promptSnippet: "Queue /review-done after the user confirms the PR review is complete",
		parameters: Type.Object({}),
		async execute() {
			pi.sendUserMessage("/review-done", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued /review-done to finish the PR review." }],
			};
		},
	});

	pi.registerCommand("review-done", {
		description: "Finish this PR review: return the treehouse worktree and close the workspace",
		getArgumentCompletions: () => null,
		handler: async (_rawArgs, ctx) => {
			const state = readState();
			const entry = Object.entries(state).find(
				([, e]) => e.status === "open" && e.worktree && resolve(ctx.cwd).startsWith(resolve(e.worktree)),
			);
			if (!entry) {
				ctx.ui.notify("No open review found for this directory in pr-review state.", "warning");
				return;
			}
			const [key, info] = entry;

			const confirmed = await ctx.ui.confirm(
				`Finish review of ${key}?`,
				[
					`Worktree: ${info.worktree}`,
					info.workspaceRef ? `Workspace: ${info.workspaceRef}` : null,
					"",
					"Returns the worktree to the treehouse pool and closes this workspace.",
				].filter((l): l is string => l !== null).join("\n"),
			);
			if (!confirmed) return;

			info.status = "done";
			writeState(state);

			// Return the worktree while running from outside it is safer, but
			// treehouse return takes an explicit path; run from home.
			try {
				await run("treehouse", ["return", info.worktree!, "--force"], homedir(), 120_000);
				ctx.ui.notify(`Returned worktree: ${info.worktree}`, "info");
			} catch (error) {
				ctx.ui.notify(`treehouse return failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}

			if (info.workspaceRef) {
				// Closing the workspace kills this pi process; do it last.
				await pi.exec("cmux", ["workspace", "close", info.workspaceRef], { cwd: homedir(), timeout: 30_000 }).catch(() => {});
			}
			ctx.shutdown();
		},
	});
}
