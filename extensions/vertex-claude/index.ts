/**
 * Vertex Claude Extension
 *
 * Registers Google Cloud Vertex AI as a provider for Claude models.
 * Uses the Anthropic Vertex SDK for authentication and streaming.
 *
 * Env: GOOGLE_CLOUD_PROJECT (required), GOOGLE_CLOUD_VERTEX_LOCATION (default: us-east5)
 */

import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { streamAnthropic } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
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
			const region = process.env.GOOGLE_CLOUD_VERTEX_LOCATION || "us-east5";

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
		models: [
			{
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7 (Vertex)",
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
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 1000000,
				maxTokens: 64000,
			},
			{
				id: "claude-haiku-4-5@20251001",
				name: "Claude Haiku 4.5 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
		],
	});
}
