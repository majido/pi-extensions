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
				id: "claude-opus-4-6@default",
				name: "Claude Opus 4.6 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
			{
				id: "claude-3-5-sonnet-v2@20241022",
				name: "Claude 3.5 Sonnet v2 (Vertex)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
		],
	});
}
