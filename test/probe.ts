/** Probe: log the agent lifecycle and what the settle boundary sees. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const log = (...parts: unknown[]) => console.error(`[probe] ${parts.join(" ")}`);

export default function (pi: ExtensionAPI) {
	for (const name of [
		"agent_start",
		"agent_end",
		"agent_before_settle",
		"agent_settled",
		"turn_start",
		"turn_end",
		"message_start",
		"message_end",
		"session_compact",
	]) {
		(pi.on as unknown as (event: string, handler: (event: any) => void) => void)(name, (event) => {
			if (name === "message_end") {
				const m = event.message;
				log(name, m?.role, m?.stopReason, m?.errorMessage ? `err=${JSON.stringify(m.errorMessage).slice(0, 60)}` : "");
				return;
			}
			if (name === "agent_before_settle") {
				const messages = event.context?.contextMessages ?? [];
				const last = [...messages].reverse().find((m: any) => m.role === "assistant");
				log(
					name,
					`outcome=${event.outcome}`,
					`canContinue=${event.context?.canContinue}`,
					`pending=${event.context?.pendingMessages?.length}`,
					`entries=${event.entries?.length}`,
					`lastAssistant=${last?.stopReason}`,
					`msgCount=${messages.length}`,
				);
				return;
			}
			log(name, event.aborted ?? "", event.reason ?? "");
		});
	}
}
