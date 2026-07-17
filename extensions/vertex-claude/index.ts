/**
 * Vertex Claude Extension
 *
 * Registers Google Cloud Vertex AI as a provider for Claude models.
 * Uses the Anthropic Vertex SDK for authentication and streaming.
 *
 * Env: PI_USE_VERTEX_FOR_CLAUDE (required to enable), GOOGLE_CLOUD_PROJECT (required), GOOGLE_CLOUD_VERTEX_LOCATION (default: us-east5)
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { streamAnthropic } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Some models are only served on the `global` Vertex endpoint (or a region
// other than the default). Map model id -> region to override per-model.
const MODEL_REGION_OVERRIDES: Record<string, string> = {
	"claude-fable-5": "global",
	"claude-sonnet-5": "global",
	"claude-opus-4-8": "global",
	"claude-opus-4-7": "global",
};

export default function (pi: ExtensionAPI) {
	if (!process.env.PI_USE_VERTEX_FOR_CLAUDE) {
		return;
	}

	pi.registerProvider("vertex-claude", {
		name: "Vertex Claude",
		baseUrl: "https://dummy",
		apiKey: "dummy",
		api: "anthropic-messages",
		streamSimple: (model, context, options) => {
			const projectId = process.env.GOOGLE_CLOUD_PROJECT;
			if (!projectId) {
				throw new Error("GOOGLE_CLOUD_PROJECT env var is required for Vertex Claude");
			}
			const defaultRegion = process.env.GOOGLE_CLOUD_VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "us-east5";
			const region = MODEL_REGION_OVERRIDES[model.id] || defaultRegion;

			const client = new AnthropicVertex({
				projectId,
				region,
			});

			return streamAnthropic(
				{ ...model, api: "anthropic-messages" },
				context,
				{
					...options,
					client: client as any,
				}
			);
		},
		// Only models verified to resolve on Vertex AI (rawPredict returns a
		// concrete model version). Aliases without a version suffix track latest.
		models: [
			{
				id: "claude-fable-5",
				name: "Claude Fable 5 (Vertex, global)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-opus-4-8",
				name: "Claude Opus 4.8 (Vertex, global)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7 (Vertex, global)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-opus-4-6",
				name: "Claude Opus 4.6 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 1000000,
				maxTokens: 128000,
			},
			{
				id: "claude-opus-4-1",
				name: "Claude Opus 4.1 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
			{
				id: "claude-opus-4",
				name: "Claude Opus 4 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
			{
				// Intro pricing $2/$10 through Aug 31 2026; standard $3/$15 after.
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5 (Vertex, global)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
				contextWindow: 1000000,
				maxTokens: 64000,
			},
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 1000000,
				maxTokens: 64000,
			},
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 1000000,
				maxTokens: 64000,
			},
			{
				id: "claude-sonnet-4",
				name: "Claude Sonnet 4 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 1000000,
				maxTokens: 64000,
			},
			{
				id: "claude-haiku-4-5",
				name: "Claude Haiku 4.5 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
			{
				id: "claude-3-5-haiku@20241022",
				name: "Claude 3.5 Haiku (Vertex)",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
		],
	});
}
