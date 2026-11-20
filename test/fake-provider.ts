/**
 * Fake provider used to exercise pi-continue end to end without a real model.
 *
 *   FAKE_SCENARIO=truncation  first turn stops with stopReason "length"
 *   FAKE_SCENARIO=error       first turn stops with pi's output-limit error text
 *   FAKE_SCENARIO=breathe     every turn stops cleanly; usage is inflated so context crosses the breath point
 *
 * Env: FAKE_WINDOW (context window), FAKE_USAGE (reported total tokens) drive the size tests.
 *
 * Run:
 *   FAKE_SCENARIO=truncation pi --no-session -e ./test/fake-provider.ts -e ./pi-continue.ts \
 *     --provider fake --model fake-model -p "start working"
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCENARIO = process.env.FAKE_SCENARIO ?? "truncation";
const num = (name: string, fallback: number) => {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};
const contextWindow = num("FAKE_WINDOW", SCENARIO === "breathe" ? 200 : 1000);
const usageTotal = num("FAKE_USAGE", SCENARIO === "breathe" ? 180 : 70);

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const lastUserText = (messages: unknown[]): string => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.map((block) => ((block as { text?: string })?.text ?? ""))
				.join(" ")
				.replace(/\s+/g, " ")
				.slice(0, 80);
		}
	}
	return "";
};

export default function (pi: ExtensionAPI) {
	let turn = 0;

	pi.registerProvider("fake", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "fake",
		api: "fake-api",
		models: [
			{
				id: "fake-model",
				name: "Fake model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: 100,
			},
		],
		streamSimple: (model, context) => {
			turn++;
			const stream = createAssistantMessageEventStream();

			const truncated = (SCENARIO === "truncation" || SCENARIO === "always") && turn === (SCENARIO === "always" ? turn : 1);
			const errored = SCENARIO === "error" && turn === 1;
			const checkpoint = SCENARIO === "breathe" && turn > 1;

			const text = truncated
				? "step 1 done, step 2 star"
				: errored
					? ""
					: checkpoint
						? "checkpoint: step 1 done; next step 2"
						: "all steps done";

			const message = {
				role: "assistant" as const,
				content: text ? [{ type: "text" as const, text }] : [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: usageTotal - 30,
					output: 30,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: usageTotal,
					cost: { ...zeroCost, total: 0 },
				},
				stopReason: "pending" as string,
				errorMessage: undefined as string | undefined,
				timestamp: 0,
			};

			const messages = (context as { messages?: unknown[] }).messages ?? [];
			console.error(
				`[fake] turn ${turn} <- ${JSON.stringify(lastUserText(messages))} | tail=${JSON.stringify(
					messages.slice(-4).map((m) => {
						const message = m as { role?: string; content?: unknown };
						return `${message?.role}:${lastUserText([m]).slice(0, 40)}`;
					}),
				)}`,
			);

			void Promise.resolve().then(() => {
				stream.push({ type: "start", partial: message } as never);
				if (text) {
					stream.push({ type: "text_start", contentIndex: 0, partial: message } as never);
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message } as never);
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message } as never);
				}
				if (truncated) {
					message.stopReason = "length";
					stream.push({ type: "done", reason: "length", message } as never);
				} else if (errored) {
					message.stopReason = "error";
					message.errorMessage =
						"Model stopped because it reached the maximum output token limit. The response may be incomplete.";
					stream.push({ type: "error", reason: "error", error: message } as never);
				} else {
					message.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message } as never);
				}
				stream.end();
				console.error(`[fake] turn ${turn} -> stopReason=${message.stopReason}`);
			});

			return stream;
		},
	});
}
