import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseSkillCatalog } from "../extensions/oh-my-omp/skill-routing/catalog";
import {
	type RouteSkillsDependencies,
	type SkillRoutingDecision,
	routeSkills,
} from "../extensions/oh-my-omp/skill-routing/router";
import {
	type SkillRoutingRuntimeOptions,
	registerSkillRouting,
} from "../extensions/oh-my-omp/skill-routing/runtime";

const SYSTEM_PROMPT = [
	[
		"ROLE",
		"<skills>",
		"- diagnose: Diagnose failures before editing.",
		"- git-master: Handle every git operation.",
		"- review-work: Review completed implementation.",
		"</skills>",
		"TOOLS",
	].join("\n"),
	"PROJECT CONTEXT",
];

describe("skill catalog parsing", () => {
	test("renders selected original lines and preserves every other byte", () => {
		const catalog = parseSkillCatalog(SYSTEM_PROMPT);

		expect(catalog).toBeDefined();
		expect(catalog?.render(new Set(["git-master", "diagnose"]))).toEqual([
			[
				"ROLE",
				"<skills>",
				"- diagnose: Diagnose failures before editing.",
				"- git-master: Handle every git operation.",
				"</skills>",
				"TOOLS",
			].join("\n"),
			"PROJECT CONTEXT",
		]);
		expect(SYSTEM_PROMPT[0]).toContain("- review-work:");
	});

	test("renders an empty catalog without changing surrounding bytes", () => {
		const catalog = parseSkillCatalog(SYSTEM_PROMPT);

		expect(catalog?.render(new Set())).toEqual([
			["ROLE", "<skills>", "</skills>", "TOOLS"].join("\n"),
			"PROJECT CONTEXT",
		]);
	});

	test("exposes parsed entries with their exact original lines", () => {
		const catalog = parseSkillCatalog(SYSTEM_PROMPT);

		expect(catalog?.entries).toEqual([
			{
				name: "diagnose",
				description: "Diagnose failures before editing.",
				line: "- diagnose: Diagnose failures before editing.",
			},
			{
				name: "git-master",
				description: "Handle every git operation.",
				line: "- git-master: Handle every git operation.",
			},
			{
				name: "review-work",
				description: "Review completed implementation.",
				line: "- review-work: Review completed implementation.",
			},
		]);
	});

	test.each([
		["missing markers", ["ROLE", "TOOLS"]],
		["missing closing marker", ["<skills>\n- diagnose: Diagnose failures."]],
		[
			"multiple catalogs",
			["<skills>\n- a: A.\n</skills>\n<skills>\n- b: B.\n</skills>"],
		],
		["nested markers", ["<skills>\n<skills>\n- a: A.\n</skills>\n</skills>"]],
		["empty catalog", ["<skills>\n</skills>"]],
		["blank interior line", ["<skills>\n- a: A.\n\n</skills>"]],
		["malformed entry", ["<skills>\na: A.\n</skills>"]],
		["blank name", ["<skills>\n- : A.\n</skills>"]],
		["duplicate name", ["<skills>\n- a: A.\n- a: Again.\n</skills>"]],
	])("rejects %s", (_name, prompt) => {
		expect(parseSkillCatalog(prompt)).toBeUndefined();
	});
});

const MODEL = {} as Model;
const CATALOG_ENTRIES = parseSkillCatalog(SYSTEM_PROMPT)?.entries ?? [];

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as AssistantMessage;
}

function dependencies(
	text: string,
	overrides: Partial<RouteSkillsDependencies> = {},
): RouteSkillsDependencies {
	return {
		complete: async () => response(text),
		timeoutMs: 50,
		...overrides,
	};
}

function input(
	overrides: Partial<Parameters<typeof routeSkills>[0]> = {},
): Parameters<typeof routeSkills>[0] {
	return {
		prompt: "Diagnose this failure, then commit it",
		entries: CATALOG_ENTRIES,
		previousNames: new Set<string>(),
		model: MODEL,
		getApiKey: async () => "credential",
		...overrides,
	};
}

describe("skill routing", () => {
	test("accepts only certain known unique skill names", async () => {
		const decision = await routeSkills(
			input(),
			dependencies(
				'{"skills":["diagnose","git-master"],"confidence":"certain"}',
			),
		);

		expect(decision).toEqual({
			kind: "selected",
			names: ["diagnose", "git-master"],
		});
	});

	test("supplies the complete mandatory selection policy", async () => {
		let instruction = "";
		let temperature: number | undefined;
		await routeSkills(
			input(),
			dependencies('{"skills":[],"confidence":"certain"}', {
				complete: async (_model, context, options) => {
					instruction = (context.systemPrompt ?? []).join("\n");
					temperature = options.temperature;
					return response('{"skills":[],"confidence":"certain"}');
				},
			}),
		);

		expect(instruction).toContain(
			"Select every triggered skill, including mandatory process skills.",
		);
		expect(instruction).toContain(
			"A skill is triggered whenever its catalog description says to use or load it for the request.",
		);
		expect(instruction).toContain(
			"Do not select skills merely because they are generally useful.",
		);
		expect(instruction).toContain(
			"Return an empty skills list only when no catalog skill applies.",
		);
		expect(instruction).toContain(
			"A request without a concrete object or goal is ambiguous; return uncertain.",
		);
		expect(temperature).toBe(0);
	});

	test("accepts a certain empty selection", async () => {
		const decision = await routeSkills(
			input(),
			dependencies('{"skills":[],"confidence":"certain"}'),
		);

		expect(decision).toEqual({ kind: "selected", names: [] });
	});

	test.each([
		[
			"surrounding prose",
			'Result: {"skills":["diagnose"],"confidence":"certain"}',
		],
		["invalid JSON", "not-json"],
		["unknown names", '{"skills":["missing"],"confidence":"certain"}'],
		[
			"duplicate names",
			'{"skills":["diagnose","diagnose"],"confidence":"certain"}',
		],
		[
			"extra object keys",
			'{"skills":["diagnose"],"confidence":"certain","extra":true}',
		],
		["missing object keys", '{"skills":["diagnose"]}'],
	] as const)("falls back for %s", async (_name, text) => {
		const decision = await routeSkills(input(), dependencies(text));

		expect(decision).toEqual({ kind: "fallback", reason: "invalid-response" });
	});

	test("falls back when the router is uncertain", async () => {
		const decision = await routeSkills(
			input(),
			dependencies('{"skills":["diagnose"],"confidence":"uncertain"}'),
		);

		expect(decision).toEqual({ kind: "fallback", reason: "uncertain" });
	});

	test("falls back when no active model exists", async () => {
		const decision = await routeSkills(
			input({ model: undefined }),
			dependencies('{"skills":[],"confidence":"certain"}'),
		);

		expect(decision).toEqual({ kind: "fallback", reason: "no-model" });
	});

	test("falls back when no credential exists", async () => {
		const decision = await routeSkills(
			input({ getApiKey: async () => undefined }),
			dependencies('{"skills":[],"confidence":"certain"}'),
		);

		expect(decision).toEqual({ kind: "fallback", reason: "no-credential" });
	});

	test("falls back when the provider rejects", async () => {
		const decision = await routeSkills(
			input(),
			dependencies("", {
				complete: async () => {
					throw new Error("provider rejected");
				},
			}),
		);

		expect(decision).toEqual({ kind: "fallback", reason: "provider-error" });
	});

	test("falls back when completion times out", async () => {
		const decision = await routeSkills(
			input(),
			dependencies("", {
				timeoutMs: 5,
				complete: async (_model, _context, options) => {
					const signal = options.signal;
					if (!signal) throw new Error("missing timeout signal");
					return new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				},
			}),
		);

		expect(decision).toEqual({ kind: "fallback", reason: "timeout" });
	});
});

interface RoutingEvent {
	prompt: string;
	systemPrompt: string[];
}

type BeforeAgentStartResult = { systemPrompt?: string[] } | undefined;

function createRoutingHarness(
	decisions: Array<SkillRoutingDecision | Promise<SkillRoutingDecision>>,
) {
	const handlers: Record<
		string,
		Array<
			(
				event: RoutingEvent,
				ctx: ExtensionContext,
			) => Promise<BeforeAgentStartResult>
		>
	> = {};
	const logs: Array<{ message: string; metadata: unknown }> = [];
	const pi = {
		on(
			event: string,
			handler: (
				event: RoutingEvent,
				ctx: ExtensionContext,
			) => Promise<BeforeAgentStartResult>,
		) {
			handlers[event] ??= [];
			handlers[event]?.push(handler);
		},
		logger: {
			debug(message: string, metadata: unknown) {
				logs.push({ message, metadata });
			},
		},
	} as unknown as ExtensionAPI;
	registerSkillRouting(pi, {
		route: async () => {
			const decision = decisions.shift();
			if (!decision) throw new Error("missing test routing decision");
			return decision;
		},
	});
	const ctx = {
		model: MODEL,
		modelRegistry: {
			getApiKey: async () => "credential",
		},
		sessionManager: {
			getSessionId: () => "session-1",
		},
	} as unknown as ExtensionContext;
	const beforeAgentStart = async (event: RoutingEvent) => {
		const handler = handlers.before_agent_start?.[0];
		if (!handler) throw new Error("before_agent_start handler missing");
		return handler(event, ctx);
	};
	const shutdown = async () => {
		const handler = handlers.session_shutdown?.[0];
		if (!handler) throw new Error("session_shutdown handler missing");
		await handler({ prompt: "", systemPrompt: [] }, ctx);
	};
	const resetSession = async (event: "session_branch" | "session_switch") => {
		const handler = handlers[event]?.[0];
		if (!handler) throw new Error(`${event} handler missing`);
		await handler({ prompt: "", systemPrompt: [] }, ctx);
	};
	return { beforeAgentStart, handlers, logs, resetSession, shutdown };
}

describe("skill routing runtime", () => {
	test("accumulates selections while replacing only the catalog", async () => {
		const runtime = createRoutingHarness([
			{ kind: "selected", names: ["diagnose"] },
			{ kind: "selected", names: ["git-master"] },
		]);
		const first = await runtime.beforeAgentStart({
			prompt: "debug",
			systemPrompt: SYSTEM_PROMPT,
		});
		const second = await runtime.beforeAgentStart({
			prompt: "commit",
			systemPrompt: SYSTEM_PROMPT,
		});

		expect(first?.systemPrompt).toEqual([
			[
				"ROLE",
				"<skills>",
				"- diagnose: Diagnose failures before editing.",
				"</skills>",
				"TOOLS",
			].join("\n"),
			"PROJECT CONTEXT",
		]);
		expect(second?.systemPrompt).toEqual([
			[
				"ROLE",
				"<skills>",
				"- diagnose: Diagnose failures before editing.",
				"- git-master: Handle every git operation.",
				"</skills>",
				"TOOLS",
			].join("\n"),
			"PROJECT CONTEXT",
		]);
	});

	test("returns the exact original prompt on routing fallback", async () => {
		const runtime = createRoutingHarness([
			{ kind: "fallback", reason: "invalid-response" },
		]);
		const event = { prompt: "ambiguous", systemPrompt: SYSTEM_PROMPT };

		const result = await runtime.beforeAgentStart(event);

		expect(result?.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(event.systemPrompt).toBe(SYSTEM_PROMPT);
	});

	test("returns the exact original prompt when catalog parsing fails", async () => {
		const runtime = createRoutingHarness([]);
		const malformed = ["ROLE", "PROJECT CONTEXT"];

		const result = await runtime.beforeAgentStart({
			prompt: "debug",
			systemPrompt: malformed,
		});

		expect(result?.systemPrompt).toBe(malformed);
	});

	test("returns the exact original prompt when routing throws", async () => {
		const runtime = createRoutingHarness([
			Promise.reject(new Error("unexpected router failure")),
		]);
		const event = { prompt: "debug", systemPrompt: SYSTEM_PROMPT };

		const result = await runtime.beforeAgentStart(event);

		expect(result?.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(runtime.logs.at(-1)?.metadata).toEqual({
			reason: "router-error",
			catalogCount: 3,
			selectedCount: 0,
		});
	});

	test("discards an in-flight decision after the session changes", async () => {
		const pending = Promise.withResolvers<SkillRoutingDecision>();
		const runtime = createRoutingHarness([
			pending.promise,
			{ kind: "selected", names: ["git-master"] },
		]);
		const staleEvent = { prompt: "debug", systemPrompt: SYSTEM_PROMPT };
		const staleResultPromise = runtime.beforeAgentStart(staleEvent);

		await runtime.resetSession("session_switch");
		pending.resolve({ kind: "selected", names: ["diagnose"] });
		const staleResult = await staleResultPromise;
		const nextResult = await runtime.beforeAgentStart({
			prompt: "commit",
			systemPrompt: SYSTEM_PROMPT,
		});

		expect(staleResult?.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(nextResult?.systemPrompt?.[0]).not.toContain("- diagnose:");
		expect(nextResult?.systemPrompt?.[0]).toContain("- git-master:");
	});

	test("logs fallback metadata without sensitive routing content", async () => {
		const runtime = createRoutingHarness([
			{ kind: "fallback", reason: "provider-error" },
		]);

		await runtime.beforeAgentStart({
			prompt: "SECRET USER PROMPT",
			systemPrompt: SYSTEM_PROMPT,
		});

		expect(runtime.logs).toEqual([
			{
				message: "Skill routing fell back to the full catalog",
				metadata: {
					reason: "provider-error",
					catalogCount: 3,
					selectedCount: 0,
				},
			},
		]);
		expect(JSON.stringify(runtime.logs)).not.toContain("SECRET USER PROMPT");
		expect(JSON.stringify(runtime.logs)).not.toContain(
			"Diagnose failures before editing.",
		);
	});

	test("clears accumulated names on session shutdown", async () => {
		const runtime = createRoutingHarness([
			{ kind: "selected", names: ["diagnose"] },
			{ kind: "selected", names: ["git-master"] },
		]);
		await runtime.beforeAgentStart({
			prompt: "debug",
			systemPrompt: SYSTEM_PROMPT,
		});

		await runtime.shutdown();
		const result = await runtime.beforeAgentStart({
			prompt: "commit",
			systemPrompt: SYSTEM_PROMPT,
		});

		expect(result?.systemPrompt?.[0]).not.toContain("- diagnose:");
		expect(result?.systemPrompt?.[0]).toContain("- git-master:");
	});

	for (const event of ["session_switch", "session_branch"] as const) {
		test(`clears accumulated names on ${event}`, async () => {
			const runtime = createRoutingHarness([
				{ kind: "selected", names: ["diagnose"] },
				{ kind: "selected", names: ["git-master"] },
			]);
			await runtime.beforeAgentStart({
				prompt: "debug",
				systemPrompt: SYSTEM_PROMPT,
			});

			await runtime.resetSession(event);
			const result = await runtime.beforeAgentStart({
				prompt: "commit",
				systemPrompt: SYSTEM_PROMPT,
			});

			expect(result?.systemPrompt?.[0]).not.toContain("- diagnose:");
			expect(result?.systemPrompt?.[0]).toContain("- git-master:");
		});
	}
});

describe("skill routing evidence", () => {
	test("records matching active-model decisions and byte-preserving context", async () => {
		const evidence = await Bun.file(
			new URL(
				"../evals/evidence/progressive-skill-routing-2026-08-19.json",
				import.meta.url,
			),
		).json();

		expect(evidence.routing_evaluation.catalog_skill_count).toBe(289);
		expect(evidence.routing_evaluation.temperature).toBe(0);
		expect(evidence.routing_evaluation.cases).toHaveLength(6);
		for (const scenario of evidence.routing_evaluation.cases) {
			if (scenario.baseline.confidence === "certain") {
				expect(scenario.comparison).toBe("exact-set-match");
				expect(scenario.candidate.decision).toBe("selected");
				expect(scenario.candidate.skills).toEqual(scenario.baseline.skills);
				if (scenario.baseline.cumulative_skills) {
					expect(scenario.candidate.cumulative_skills).toEqual(
						scenario.baseline.cumulative_skills,
					);
				}
			} else {
				expect(scenario.comparison).toBe("exact-original-prompt-fallback");
				expect(scenario.candidate).toEqual({
					decision: "fallback",
					reason: "uncertain",
				});
			}
		}
		expect(
			evidence.context_probe.active_subprocess_render.non_skill_digest_after,
		).toBe(
			evidence.context_probe.active_subprocess_render.non_skill_digest_before,
		);
		expect(evidence.context_probe.full_discovery_inventory.visible_skills).toBe(
			289,
		);
		expect(
			evidence.context_probe.active_subprocess_render.after_catalog_skills,
		).toBe(0);
	});
});
