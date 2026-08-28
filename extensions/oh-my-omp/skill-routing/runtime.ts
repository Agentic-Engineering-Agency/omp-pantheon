import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parseSkillCatalog } from "./catalog";
import {
	type RouteSkillsInput,
	type SkillRoutingDecision,
	routeSkills,
} from "./router";

export interface SkillRoutingRuntimeOptions {
	route(input: RouteSkillsInput): Promise<SkillRoutingDecision>;
}

const DEFAULT_OPTIONS: SkillRoutingRuntimeOptions = {
	route: routeSkills,
};

export function registerSkillRouting(
	pi: ExtensionAPI,
	options: SkillRoutingRuntimeOptions = DEFAULT_OPTIONS,
): void {
	const selectedNames = new Set<string>();
	let sessionGeneration = 0;

	pi.on("before_agent_start", async (event, ctx) => {
		const catalog = parseSkillCatalog(event.systemPrompt);
		if (!catalog) {
			pi.logger.debug("Skill routing fell back to the full catalog", {
				reason: "catalog-parse",
				catalogCount: 0,
				selectedCount: selectedNames.size,
			});
			return { systemPrompt: event.systemPrompt };
		}

		const routeGeneration = sessionGeneration;
		let decision: SkillRoutingDecision;
		try {
			decision = await options.route({
				prompt: event.prompt,
				entries: catalog.entries,
				previousNames: selectedNames,
				model: ctx.model,
				getApiKey: (model, signal) =>
					ctx.modelRegistry.getApiKey(
						model,
						ctx.sessionManager.getSessionId(),
						{ signal },
					),
			});
		} catch {
			pi.logger.debug("Skill routing fell back to the full catalog", {
				reason: "router-error",
				catalogCount: catalog.entries.length,
				selectedCount: selectedNames.size,
			});
			return { systemPrompt: event.systemPrompt };
		}
		if (routeGeneration !== sessionGeneration) {
			pi.logger.debug("Skill routing fell back to the full catalog", {
				reason: "session-changed",
				catalogCount: catalog.entries.length,
				selectedCount: selectedNames.size,
			});
			return { systemPrompt: event.systemPrompt };
		}
		if (decision.kind === "fallback") {
			pi.logger.debug("Skill routing fell back to the full catalog", {
				reason: decision.reason,
				catalogCount: catalog.entries.length,
				selectedCount: selectedNames.size,
			});
			return { systemPrompt: event.systemPrompt };
		}

		for (const name of decision.names) selectedNames.add(name);
		return { systemPrompt: catalog.render(selectedNames) };
	});

	const clearSelectedNames = () => {
		sessionGeneration += 1;
		selectedNames.clear();
	};
	pi.on("session_switch", clearSelectedNames);
	pi.on("session_branch", clearSelectedNames);
	pi.on("session_shutdown", clearSelectedNames);
}
