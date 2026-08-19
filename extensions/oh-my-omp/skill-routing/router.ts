import {
	complete as completeModel,
	type AssistantMessage,
	type Context,
	type Model,
	type StreamOptions,
} from "@oh-my-pi/pi-ai";
import type { SkillCatalogEntry } from "./catalog";

export type SkillRoutingFailureReason =
	| "no-model"
	| "no-credential"
	| "timeout"
	| "provider-error"
	| "invalid-response"
	| "uncertain";

export type SkillRoutingDecision =
	| { kind: "selected"; names: readonly string[] }
	| { kind: "fallback"; reason: SkillRoutingFailureReason };

export interface RouteSkillsInput {
	prompt: string;
	entries: readonly SkillCatalogEntry[];
	previousNames: ReadonlySet<string>;
	model: Model | undefined;
	getApiKey(
		model: Model,
		signal: AbortSignal,
	): Promise<string | undefined>;
}

export type SkillRoutingComplete = (
	model: Model,
	context: Context,
	options: StreamOptions,
) => Promise<AssistantMessage>;

export interface RouteSkillsDependencies {
	complete: SkillRoutingComplete;
	timeoutMs: number;
}

const DEFAULT_DEPENDENCIES: RouteSkillsDependencies = {
	complete: completeModel as SkillRoutingComplete,
	timeoutMs: 10_000,
};

function buildInstruction(input: RouteSkillsInput): string[] {
	const catalog = input.entries.map((entry) => entry.line).join("\n");
	const previous = [...input.previousNames].join(", ") || "(none)";
	return [
		"Select the skills required to handle the user request.",
		"Use only names from the catalog. Do not invoke tools or read skill bodies.",
		"Return JSON only, with exactly these keys and schema:",
		'{"skills":["skill-name"],"confidence":"certain"|"uncertain"}',
		"Use confidence=uncertain whenever the catalog is insufficient or selection is ambiguous.",
		`Previously selected in this session: ${previous}`,
		"Complete skill catalog:",
		catalog,
	];
}

function parseDecision(
	message: AssistantMessage,
	knownNames: ReadonlySet<string>,
): SkillRoutingDecision {
	const textBlocks = message.content.filter(
		(block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
			block.type === "text",
	);
	if (textBlocks.length !== 1) {
		return { kind: "fallback", reason: "invalid-response" };
	}

	let value: unknown;
	try {
		value = JSON.parse(textBlocks[0]?.text ?? "");
	} catch {
		return { kind: "fallback", reason: "invalid-response" };
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { kind: "fallback", reason: "invalid-response" };
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "confidence" || keys[1] !== "skills") {
		return { kind: "fallback", reason: "invalid-response" };
	}
	if (record.confidence === "uncertain") {
		return { kind: "fallback", reason: "uncertain" };
	}
	if (record.confidence !== "certain" || !Array.isArray(record.skills)) {
		return { kind: "fallback", reason: "invalid-response" };
	}

	const names: string[] = [];
	const uniqueNames = new Set<string>();
	for (const name of record.skills) {
		if (
			typeof name !== "string" ||
			!knownNames.has(name) ||
			uniqueNames.has(name)
		) {
			return { kind: "fallback", reason: "invalid-response" };
		}
		uniqueNames.add(name);
		names.push(name);
	}

	return { kind: "selected", names };
}

export async function routeSkills(
	input: RouteSkillsInput,
	dependencies: RouteSkillsDependencies = DEFAULT_DEPENDENCIES,
): Promise<SkillRoutingDecision> {
	if (!input.model) return { kind: "fallback", reason: "no-model" };

	const signal = AbortSignal.timeout(dependencies.timeoutMs);
	let apiKey: string | undefined;
	try {
		apiKey = await input.getApiKey(input.model, signal);
	} catch {
		return {
			kind: "fallback",
			reason: signal.aborted ? "timeout" : "provider-error",
		};
	}
	if (!apiKey) return { kind: "fallback", reason: "no-credential" };

	try {
		const message = await dependencies.complete(
			input.model,
			{
				systemPrompt: buildInstruction(input),
				messages: [
					{
						role: "user",
						content: input.prompt,
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, maxTokens: 512, signal },
		);
		return parseDecision(
			message,
			new Set(input.entries.map((entry) => entry.name)),
		);
	} catch {
		return {
			kind: "fallback",
			reason: signal.aborted ? "timeout" : "provider-error",
		};
	}
}
