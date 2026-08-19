import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parseSkillCatalog } from "./catalog";
import {
	routeSkills,
	type RouteSkillsInput,
	type SkillRoutingDecision,
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

		const decision = await options.route({
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

	pi.on("session_shutdown", () => {
		selectedNames.clear();
	});
}
