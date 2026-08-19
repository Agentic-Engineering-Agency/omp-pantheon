import { describe, expect, test } from "bun:test";
import { parseSkillCatalog } from "../extensions/oh-my-omp/skill-routing/catalog";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import {
	type RouteSkillsDependencies,
	routeSkills,
} from "../extensions/oh-my-omp/skill-routing/router";

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
		["multiple catalogs", ["<skills>\n- a: A.\n</skills>\n<skills>\n- b: B.\n</skills>"]],
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
		[
			"unknown names",
			'{"skills":["missing"],"confidence":"certain"}',
		],
		[
			"duplicate names",
			'{"skills":["diagnose","diagnose"],"confidence":"certain"}',
		],
		[
			"extra object keys",
			'{"skills":["diagnose"],"confidence":"certain","extra":true}',
		],
		[
			"missing object keys",
			'{"skills":["diagnose"]}',
		],
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
