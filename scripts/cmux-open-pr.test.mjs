import assert from "node:assert/strict";
import test from "node:test";

import {
	findExistingWorkspace,
	parsePrReference,
	piSessionName,
	routePr,
	workspaceTitle,
} from "./cmux-open-pr.mjs";

const referenceScenarios = [
	{
		name: "short repo reference",
		input: "iris#200",
		expected: { repoName: "iris", number: 200 },
	},
	{
		name: "slash repo reference",
		input: "iris/200",
		expected: { repoName: "iris", number: 200 },
	},
	{
		name: "owner and repo reference",
		input: "hopper-org/iris#200",
		expected: { repoFull: "hopper-org/iris", repoName: "iris", number: 200 },
	},
	{
		name: "GitHub PR URL",
		input: "https://github.com/hopper-org/iris/pull/200",
		expected: { repoFull: "hopper-org/iris", repoName: "iris", number: 200 },
	},
];

for (const scenario of referenceScenarios) {
	test(`parses ${scenario.name}`, () => {
		assert.deepEqual(parsePrReference(scenario.input), scenario.expected);
	});
}

test("uses distinct workspace and Pi session names for PR checks", () => {
	const ref = { repoName: "iris", number: 200 };

	assert.equal(workspaceTitle(ref), "🦄 iris#200");
	assert.equal(piSessionName(ref), "pr check - iris#200");
});

test("finds an exact workspace title across cmux windows", async () => {
	const run = async (_command, args) => {
		if (args[0] === "list-windows") {
			return JSON.stringify([{ id: "window-a" }, { id: "window-b" }]);
		}
		if (args.includes("window-a")) {
			return JSON.stringify({ workspaces: [{ id: "workspace-a", custom_title: "Other" }] });
		}
		return JSON.stringify({
			workspaces: [{ id: "workspace-b", custom_title: "🦄 iris#200", title: "ignored" }],
		});
	};

	assert.deepEqual(await findExistingWorkspace(run, "🦄 iris#200"), {
		windowId: "window-b",
		workspaceId: "workspace-b",
	});
});

test("continues searching when a cmux window closes during the scan", async () => {
	const run = async (_command, args) => {
		if (args[0] === "list-windows") {
			return JSON.stringify([{ id: "closed-window" }, { id: "live-window" }]);
		}
		if (args.includes("closed-window")) throw new Error("window closed");
		return JSON.stringify({
			workspaces: [{ id: "workspace-b", custom_title: "🦄 iris#200" }],
		});
	};

	assert.deepEqual(await findExistingWorkspace(run, "🦄 iris#200"), {
		windowId: "live-window",
		workspaceId: "workspace-b",
	});
});

test("focuses an existing workspace without creating a PR session", async () => {
	const events = [];

	const result = await routePr("iris#200", {
		findExisting: async (title) => {
			events.push(`find:${title}`);
			return { windowId: "window-id", workspaceId: "workspace-id" };
		},
		focusExisting: async (target) => events.push(`focus:${target.workspaceId}`),
		create: async () => events.push("create"),
	});

	assert.deepEqual(events, ["find:🦄 iris#200", "focus:workspace-id"]);
	assert.equal(result.status, "focused");
});

test("creates a PR session only after no existing workspace is found", async () => {
	const events = [];

	const result = await routePr("iris#200", {
		findExisting: async () => {
			events.push("find");
			return undefined;
		},
		focusExisting: async () => events.push("focus"),
		create: async (_ref, names) => events.push(`create:${names.workspace}:${names.session}`),
	});

	assert.deepEqual(events, ["find", "create:🦄 iris#200:pr check - iris#200"]);
	assert.equal(result.status, "created");
});
