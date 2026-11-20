/**
 * pi-continue — keep the model running when the output token limit cuts it off.
 *
 * Pi marks an output-limit stop as an assistant message with `stopReason: "length"`,
 * or with the error text:
 *   "Model stopped because it reached the maximum output token limit. The response may be incomplete."
 * This extension watches for both and, at the settle boundary (the last moment before the
 * agent would go idle), injects the prompt `continue` so the model resumes where it stopped.
 *
 * It also keeps a running measure of context size:
 *   - a footer status: `ctx 46% 60k/131k · compact>66k · continue 2/8 · breathing`
 *   - before the context gets heavy it asks the model to *take a breath*: a short tool-free
 *     checkpoint of what is done and what comes next. The `continue` prompt is only sent after
 *     that checkpoint has landed, so the resume happens from a compact restatement instead of
 *     from a nearly full window.
 *
 * The breath point is headroom-aware. Pi compacts automatically once
 * `contextTokens > contextWindow - compaction.reserveTokens`, so a fixed percentage would fire
 * too late on a model whose reserve is large (e.g. 131k window with 64k reserve compacts at 50%).
 * The threshold is therefore `min(PI_CONTINUE_BREATHE_AT%, compaction point - margin)`, read from
 * the same settings Pi uses (global settings.json, project .pi/settings.json, per-model overrides).
 *
 * Commands:
 *   /continue            send the continue prompt now
 *   /continue status     context size + what the extension has done
 *   /continue on|off     toggle automatic behaviour
 *   /continue breathe    force a breath cycle at the next settle boundary
 *   /continue compact    compact now, then continue from the summary
 *
 * Environment (read once at load):
 *   PI_CONTINUE_MESSAGE=<text>        continuation prompt (default: "continue")
 *   PI_CONTINUE_BREATHE_AT=<percent>  context %% that triggers a breath (default: 80)
 *   PI_CONTINUE_HARD_AT=<percent>     context %% that also asks to save state (default: 93)
 *   PI_CONTINUE_COMPACT_MARGIN=<tok>  tokens before Pi's auto-compaction point to breathe (6000)
 *   PI_CONTINUE_RESERVE_TOKENS=<tok>  override compaction.reserveTokens (0 = read settings)
 *   PI_CONTINUE_MAX=<n>               consecutive auto-continues before giving up (default: 8)
 *   PI_CONTINUE_OFF=1                 start disabled
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

/** Minimal shape of an assistant message; avoids depending on pi-ai types. */
interface AssistantLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

const DRAFT_TYPE = "pi-continue";

const numEnv = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
};

const CONFIG = {
	message: process.env.PI_CONTINUE_MESSAGE || "continue",
	breatheAt: numEnv("PI_CONTINUE_BREATHE_AT", 80),
	hardAt: numEnv("PI_CONTINUE_HARD_AT", 93),
	compactMargin: numEnv("PI_CONTINUE_COMPACT_MARGIN", 6000),
	reserveTokens: numEnv("PI_CONTINUE_RESERVE_TOKENS", 0),
	maxStreak: numEnv("PI_CONTINUE_MAX", 8),
	enabled: process.env.PI_CONTINUE_OFF !== "1",
};

/** Pi's own default, mirrored so the estimate is right before settings are read. */
const DEFAULT_RESERVE_TOKENS = 16384;

interface CompactionSnapshot {
	enabled: boolean;
	reserveTokens: number;
	source: string;
}

interface CompactionFile {
	compaction?: {
		enabled?: boolean;
		reserveTokens?: number;
		modelOverrides?: Record<string, { reserveTokens?: number }>;
	};
}

/**
 * Read the compaction settings Pi itself would use: global settings first, then the project
 * override, then the per-model override. Best effort; a missing or broken file keeps defaults.
 */
const readCompactionSettings = (cwd: string, modelKey?: string): CompactionSnapshot => {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	let snapshot: CompactionSnapshot = { enabled: true, reserveTokens: DEFAULT_RESERVE_TOKENS, source: "default" };
	for (const path of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
		try {
			if (!existsSync(path)) continue;
			const compaction = (JSON.parse(readFileSync(path, "utf8")) as CompactionFile)?.compaction;
			if (!compaction || typeof compaction !== "object") continue;
			if (typeof compaction.enabled === "boolean") snapshot = { ...snapshot, enabled: compaction.enabled, source: path };
			if (typeof compaction.reserveTokens === "number" && compaction.reserveTokens >= 0) {
				snapshot = { ...snapshot, reserveTokens: compaction.reserveTokens };
			}
			const override = modelKey ? compaction.modelOverrides?.[modelKey] : undefined;
			if (override && typeof override.reserveTokens === "number" && override.reserveTokens >= 0) {
				snapshot = { ...snapshot, reserveTokens: override.reserveTokens };
			}
		} catch {
			/* unreadable settings file: keep what we have */
		}
	}
	if (CONFIG.reserveTokens > 0) {
		snapshot = { ...snapshot, reserveTokens: CONFIG.reserveTokens, source: "PI_CONTINUE_RESERVE_TOKENS" };
	}
	return snapshot;
};

interface Points {
	/** Token counts at which a breath, and a hard save-the-state push, should fire. */
	breathe: number;
	hard: number;
	/** Token count above which Pi compacts automatically, when compaction is on. */
	compactAt: number | undefined;
	compaction: CompactionSnapshot;
}

/** Where the context cliffs are for the current usage, given Pi's compaction settings. */
const pointsFor = (usage: ContextUsage, compaction: CompactionSnapshot): Points => {
	const window = usage.contextWindow;
	const compactAt = compaction.enabled ? Math.max(1, window - compaction.reserveTokens) : undefined;
	const cap = (percentPoint: number, margin: number) =>
		compactAt === undefined ? percentPoint : Math.min(percentPoint, Math.max(0, compactAt - margin));
	return {
		breathe: cap((CONFIG.breatheAt / 100) * window, CONFIG.compactMargin),
		hard: cap((CONFIG.hardAt / 100) * window, 0),
		compactAt,
		compaction,
	};
};

/**
 * Text patterns that mean "the answer was cut off by the output token limit",
 * for the providers and errors that report it as text instead of stopReason.
 */
const OUTPUT_LIMIT_PATTERNS: RegExp[] = [
	/reached the maximum output token limit/i,
	/max(imum)? output token/i,
	/output token (limit|cap|budget)/i,
	/exceeded (the )?output (tokens|limit)/i,
	/\bmax_tokens\b/i,
	/finish_reason\D{0,4}["']?length/i,
	/maximum (number of )?tokens to (generate|produce|output)/i,
	/(response|message|answer|text|turn|truncat\w+).{0,40}\btoken limit\b/i,
	/token limit.{0,40}(reached|exceeded|hit)/i,
	/incomplete (message|response|answer|text|turn|output)/i,
];

const state = {
	enabled: CONFIG.enabled,
	/** Consecutive auto-continues without the model finishing a turn cleanly. */
	streak: 0,
	continues: 0,
	breaths: 0,
	/** A breath was requested and its checkpoint has not landed yet. */
	breatheDebt: false,
	/** A breath may still be injected at this context level. */
	breatheArmed: true,
	usage: undefined as ContextUsage | undefined,
	compaction: undefined as CompactionSnapshot | undefined,
	stopped: false,
};

const fmtK = (value: number | null | undefined): string => (value === null || value === undefined ? "?" : fmtTokens(value));

const fmtTokens = (value: number | null | undefined): string => {
	if (value === null || value === undefined) return "?";
	if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
	return `${Math.round(value)}`;
};

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			out += `${(block as { text?: string }).text ?? ""}\n`;
		}
	}
	return out;
};

/** Why the last assistant message stopped, when it was cut off by the output limit. */
const truncatedBy = (message: AssistantLike | undefined): "length" | "output_limit" | undefined => {
	if (!message || message.role !== "assistant") return undefined;
	const reason = (message.stopReason ?? "").toLowerCase();
	if (reason === "length") return "length";
	if (reason === "error" || reason === "aborted") {
		const haystack = `${message.errorMessage ?? ""}\n${textOf(message.content)}`;
		if (OUTPUT_LIMIT_PATTERNS.some((pattern) => pattern.test(haystack))) return "output_limit";
	}
	return undefined;
};

const lastAssistant = (messages: unknown[]): AssistantLike | undefined => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as AssistantLike | undefined;
		if (message && typeof message === "object" && message.role === "assistant") return message;
	}
	return undefined;
};

const breathText = (usage: ContextUsage, points: Points): string => {
	const pct = Math.round(usage.percent ?? 0);
	const hard = (usage.tokens ?? 0) >= points.hard;
	const lines = [
		`[pi-continue] Context checkpoint: ${pct}% of the ${fmtTokens(usage.contextWindow)} token window is in use (~${fmtTokens(usage.tokens)} tokens).`,
		"Take a breath before doing anything else. In at most six short lines, and without calling any tool, state:",
		"1. what is already done,",
		"2. the exact next step,",
		"3. any decision, path, or constraint that must not be lost.",
		"Do not redo, extend, or verify the work in this reply. You will be told to continue afterwards, and that is when you resume.",
	];
	if (hard) {
		lines.push(
			`The context is nearly full (it compacts above ~${fmtTokens(points.compactAt ?? usage.contextWindow)} tokens): if any state exists only in this conversation, write it to a file during the checkpoint, and say if /compact is needed.`,
		);
	}
	return lines.join("\n");
};

const continueDraft = (reason: string, usage?: ContextUsage): SessionBoundaryDraft => ({
	type: "custom_message",
	customType: DRAFT_TYPE,
	content: CONFIG.message,
	display: true,
	details: { reason, at: usage?.percent === null || usage?.percent === undefined ? undefined : Math.round(usage.percent) },
});

const breathDraft = (usage: ContextUsage, points: Points): SessionBoundaryDraft => ({
	type: "custom_message",
	customType: DRAFT_TYPE,
	content: breathText(usage, points),
	display: true,
	details: { reason: "breathe", at: Math.round(usage.percent ?? 0) },
});

export default function (pi: ExtensionAPI) {
	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		try {
			ctx.ui.setStatus(DRAFT_TYPE, text);
		} catch {
			/* headless or a TUI that does not expose a status bar */
		}
	};

	const syncCompaction = (ctx: ExtensionContext) => {
		const model = ctx.model;
		state.compaction = readCompactionSettings(ctx.cwd, model ? `${model.provider}/${model.id}` : undefined);
	};

	const pointsForUsage = (ctx: ExtensionContext, usage: ContextUsage): Points =>
		pointsFor(usage, state.compaction ?? readCompactionSettings(ctx.cwd, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined));

	const refreshStatus = (ctx: ExtensionContext) => {
		if (!state.enabled) {
			setStatus(ctx, undefined);
			return;
		}
		const usage = ctx.getContextUsage();
		state.usage = usage;
		if (!usage || usage.tokens === null || usage.percent === null) {
			setStatus(ctx, ctx.ui.theme.fg("muted", "ctx …"));
			return;
		}
		const points = pointsForUsage(ctx, usage);
		const pct = Math.max(0, Math.round(usage.percent));
		const tone = usage.tokens >= points.hard ? "error" : usage.tokens >= points.breathe ? "warning" : "success";
		const parts = [
			`${ctx.ui.theme.fg("muted", "ctx")} ${ctx.ui.theme.fg(tone, `${pct}%`)} ${ctx.ui.theme.fg(
				"dim",
				`${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`,
			)}`,
		];
		if (points.compactAt !== undefined) {
			parts.push(ctx.ui.theme.fg("dim", `compact>${fmtK(points.compactAt)}`));
		}
		if (state.breatheDebt) parts.push(ctx.ui.theme.fg("warning", "breathing"));
		else if (state.streak > 0) parts.push(ctx.ui.theme.fg("warning", `continue ${state.streak}/${CONFIG.maxStreak}`));
		else if (usage.tokens >= points.breathe && state.breatheArmed) parts.push(ctx.ui.theme.fg("muted", "breath armed"));
		setStatus(ctx, parts.join(ctx.ui.theme.fg("dim", " · ")));
	};

	const note = (ctx: ExtensionContext, message: string, kind: "info" | "warning" = "info") => {
		try {
			ctx.ui.notify(`pi-continue: ${message}`, kind);
		} catch {
			/* headless */
		}
	};

	// ---------------------------------------------------------------- detection

	pi.on("message_end", (event, ctx) => {
		const reason = truncatedBy(event.message as AssistantLike);
		if (reason) state.stopped = true;
		refreshStatus(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		const message = event.message as AssistantLike | undefined;
		if (message?.role === "assistant" && message.stopReason === "stop") {
			state.streak = 0;
			state.stopped = false;
		}
		refreshStatus(ctx);
	});

	// ------------------------------------------------------- the settle boundary

	// AgentBeforeSettleEvent carries the boundary state itself: `outcome`, `entries`,
	// `continue`, and the read-only `context` preview.
	pi.on("agent_before_settle", (event, ctx) => {
		const boundary = event;
		const usage = ctx.getContextUsage();
		state.usage = usage;

		// Room again (after compaction, a model switch, or a shorter window): the breath is available.
		const points = usage ? pointsForUsage(ctx, usage) : undefined;
		if (usage && usage.tokens !== null && points && usage.tokens < points.breathe) state.breatheArmed = true;

		if (!state.enabled) return undefined;
		if (boundary.outcome === "aborted") {
			state.streak = 0;
			state.breatheDebt = false;
			return undefined;
		}
		// A queued user message already keeps the session going; do not stack on top of it.
		if (boundary.context.pendingMessages.length > 0) return undefined;

		const reason =
			truncatedBy(lastAssistant(boundary.context.contextMessages)) ?? (state.stopped ? "length" : undefined);
		const hasWorkToResume = reason !== undefined || state.breatheDebt;

		// Too many truncated turns in a row: stop pushing, ask the user instead.
		if (reason && state.streak >= CONFIG.maxStreak) {
			note(ctx, `stopped continuing after ${CONFIG.maxStreak} truncated turns — send /continue to push on`, "warning");
			state.streak = 0;
			state.breatheDebt = false;
			state.stopped = false;
			return undefined;
		}

		// A heavy context takes the breath first. The `continue` prompt is deliberately held back
		// until the checkpoint has landed, so the resume starts from a compact restatement and not
		// from a window that is about to be compacted out from under the model.
		if (hasWorkToResume && usage && usage.tokens !== null && points && usage.tokens >= points.breathe && state.breatheArmed) {
			state.breatheArmed = false;
			state.breatheDebt = true;
			state.breaths++;
			state.stopped = false;
			note(ctx, `context at ${Math.round(usage.percent ?? 0)}% (~${fmtTokens(usage.tokens)} tokens) — taking a breath before continuing`);
			refreshStatus(ctx);
			return { entries: [breathDraft(usage, points)], continue: true };
		}

		// The checkpoint has landed: now, and only now, ask for the work to continue.
		if (state.breatheDebt) {
			state.breatheDebt = false;
			state.continues++;
			state.stopped = false;
			if (reason) state.streak++;
			note(ctx, "checkpoint taken — continuing from it");
			refreshStatus(ctx);
			return { entries: [continueDraft("after-breath", usage)], continue: true };
		}

		if (reason) {
			// Pi validates the context after the drafts are committed, and a context that
			// ends with the truncated assistant message is not runnable on its own: the
			// injected `continue` message is what makes it continuable. So the draft always
			// accompanies `continue: true` instead of checking the pre-draft preview.
			state.streak++;
			state.continues++;
			state.stopped = false;
			note(ctx, `response hit the output token limit — continuing (${state.streak}/${CONFIG.maxStreak})`);
			refreshStatus(ctx);
			return { entries: [continueDraft(reason, usage)], continue: true };
		}

		return undefined;
	});

	// ------------------------------------------------------------- session noise

	const pctOf = (tokens: number, window: number) => (window > 0 ? Math.round((tokens / window) * 100) : 0);

	pi.on("session_start", (_event, ctx) => {
		state.streak = 0;
		state.breatheArmed = true;
		state.breatheDebt = false;
		syncCompaction(ctx);
		refreshStatus(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		state.breatheArmed = true;
		state.breatheDebt = false;
		refreshStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		syncCompaction(ctx);
		refreshStatus(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => refreshStatus(ctx));
	pi.on("session_tree", (_event, ctx) => refreshStatus(ctx));
	pi.on("agent_end", (_event, ctx) => refreshStatus(ctx));

	// ------------------------------------------------------------------ commands

	pi.registerCommand("continue", {
		description: "Send the continue prompt, or control auto-continue (status|on|off|breathe|compact)",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();

			if (sub === "on" || sub === "off") {
				state.enabled = sub === "on";
				if (!state.enabled) {
					state.streak = 0;
					state.breatheDebt = false;
				}
				refreshStatus(ctx);
				note(ctx, sub === "on" ? "auto-continue enabled" : "auto-continue disabled");
				return;
			}

			if (sub === "breathe") {
				state.breatheArmed = true;
				state.breaths++;
				const usage = ctx.getContextUsage() ?? { tokens: null, contextWindow: 0, percent: null };
				pi.sendMessage({
					customType: DRAFT_TYPE,
					content: breathText(usage, pointsForUsage(ctx, usage)),
					display: true,
					details: { reason: "breathe-manual" },
				});
				return;
			}

			if (sub === "compact") {
				ctx.compact({
					customInstructions: "Preserve the exact next step and any unfinished work so the session can continue seamlessly.",
					onComplete: () => pi.sendUserMessage(CONFIG.message),
					onError: () => note(ctx, "compaction failed — continuing without it", "warning"),
				});
				return;
			}

			const usage = ctx.getContextUsage();
			if (sub === "status" || sub === "") {
				syncCompaction(ctx);
				const points = usage ? pointsForUsage(ctx, usage) : undefined;
				const window = usage?.contextWindow ?? 0;
				const at = (tokens: number | undefined) =>
					tokens === undefined ? "off" : `${fmtTokens(tokens)} (${pctOf(tokens, window)}%)`;
				const lines = [
					`auto-continue: ${state.enabled ? "on" : "off"} (consecutive ${state.streak}/${CONFIG.maxStreak}, session total ${state.continues})`,
					`continue prompt: ${JSON.stringify(CONFIG.message)}`,
					usage
						? `context: ${usage.tokens === null ? "?" : fmtTokens(usage.tokens)} / ${fmtTokens(usage.contextWindow)} tokens (${usage.percent === null ? "?" : `${Math.round(usage.percent)}%`})${ctx.model ? ` · ${ctx.model.provider}/${ctx.model.id}` : ""}`
						: "context: unknown",
					`auto-compaction: ${state.compaction?.enabled ? `on, above ${at(points?.compactAt)} (reserveTokens ${fmtTokens(state.compaction.reserveTokens)}, ${state.compaction.source})` : "off"}`,
					`breathe at: ${at(points?.breathe)} · hard push at: ${at(points?.hard)} · margin ${CONFIG.compactMargin} tokens`,
					`breaths: ${state.breaths} (armed ${state.breatheArmed ? "yes" : "no"}${state.breatheDebt ? ", checkpoint pending" : ""})`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				if (sub === "") pi.sendUserMessage(CONFIG.message);
				return;
			}

			ctx.ui.notify("pi-continue: usage /continue [status|on|off|breathe|compact]", "warning");
		},
	});
}
