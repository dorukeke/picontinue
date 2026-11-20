/** Logs why pi compacts and what the extension-visible usage is at each boundary. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", (event, ctx) => {
		console.error(
			`[probe] before_compact reason=${(event as { reason?: string }).reason} willRetry=${String(
				(event as { willRetry?: boolean }).willRetry,
			)} usage=${JSON.stringify(ctx.getContextUsage())}`,
		);
	});
	pi.on("agent_before_settle", (event, ctx) => {
		console.error(
			`[probe] settle outcome=${event.outcome} usage=${JSON.stringify(ctx.getContextUsage())} model=${ctx.model?.provider}/${ctx.model?.id} cwd=${ctx.cwd}`,
		);
	});
	pi.on("session_compact", (_event, ctx) => {
		console.error(`[probe] session_compact usage=${JSON.stringify(ctx.getContextUsage())}`);
	});
}
