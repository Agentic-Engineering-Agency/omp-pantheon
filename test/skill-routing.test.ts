import { describe, expect, test } from "bun:test";
import { parseSkillCatalog } from "../extensions/oh-my-omp/skill-routing/catalog";

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
