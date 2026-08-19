import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { dispatch } from "../skills/evalfly/bin/evalfly.ts";

const root = join(import.meta.dir, "..");

const criticalEvalFiles = [
	"README.md",
	"commands/evalfly-enforce.md",
	"skills/evalfly/bin/evalfly.ts",
	"skills/evalfly/bin/enforcement-state.ts",
	"extensions/oh-my-omp/evalfly/enforcement-gate.ts",
	"extensions/oh-my-omp/evalfly/trace-buffer.ts",
	".github/workflows/verify.yml",
	"docs/evalfly/modes.md",
	"skills/evaluation-flywheel/SKILL.md",
	"test/evalfly-enforcement-gate.test.ts",
	"test/specsafe-cli.test.ts",
] as const;

const progressiveSkillRoutingFiles = [
	"extensions/oh-my-omp/skill-routing/runtime.ts",
	"test/skill-routing.test.ts",
] as const;

describe("omp-pantheon EvalFly project repo", () => {
	test("defines a real smoke suite for critical EvalFly harness files", async () => {
		const config = JSON.parse(
			await readFile(join(root, "evals", "config.json"), "utf8"),
		);

		expect(config.schema_version).toBe("evalfly.config.v1");
		expect(config.name).toBe("omp-pantheon EvalFly smoke suite");
		expect(config.cases).toHaveLength(criticalEvalFiles.length + 1);
		expect(
			config.cases.map((testCase: { case_id: string }) => testCase.case_id),
		).toEqual([
			"root-readme-exists",
			"evalfly-enforce-command-exists",
			"evalfly-cli-exists",
			"evalfly-enforcement-state-exists",
			"evalfly-completion-gate-exists",
			"evalfly-trace-buffer-exists",
			"verify-workflow-exists",
			"evalfly-modes-doc-exists",
			"evaluation-flywheel-skill-exists",
			"evalfly-gate-test-exists",
			"specsafe-recovery-regression-exists",
			"progressive-skill-routing-regression-exists",
		]);

		for (const [index, testCase] of config.cases.entries()) {
			expect(testCase.suite).toBe("smoke");
			expect(testCase.risk_tier).toBe("critical");
			expect(testCase.privacy).toEqual({
				classification: "public",
				sanitized: true,
			});
			const assertions =
				index < criticalEvalFiles.length
					? [{ type: "file_exists", path: criticalEvalFiles[index] }]
					: progressiveSkillRoutingFiles.map((path) => ({
							type: "file_exists",
							path,
						}));
			expect(testCase.judge).toEqual({
				type: "deterministic",
				assertions,
			});
		}
	});

	test("standalone case files match config cases", async () => {
		const config = JSON.parse(
			await readFile(join(root, "evals", "config.json"), "utf8"),
		);
		const caseFiles = (await readdir(join(root, "evals", "cases"))).sort();
		expect(caseFiles).toEqual(
			config.cases
				.map((testCase: { case_id: string }) => `${testCase.case_id}.json`)
				.sort(),
		);

		for (const testCase of config.cases) {
			const caseFile = JSON.parse(
				await readFile(
					join(root, "evals", "cases", `${testCase.case_id}.json`),
					"utf8",
				),
			);
			expect(caseFile).toEqual(testCase);
		}
	});

	test("project smoke suite passes through the EvalFly runner", async () => {
		const result = await dispatch(
			["check", "--suite", "smoke", "--commit-range", "main..HEAD"],
			{
				cwd: root,
				now: () => new Date("2026-06-20T22:30:00.000Z"),
				runId: "run-omp-pantheon-smoke-test",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain(
			"evalfly check run-omp-pantheon-smoke-test: pass",
		);
		expect(result.stdout).toContain(
			"report: evals/reports/run-omp-pantheon-smoke-test.md",
		);

		await rm(join(root, "evals", "runs", "run-omp-pantheon-smoke-test.json"), {
			force: true,
		});
		await rm(join(root, "evals", "reports", "run-omp-pantheon-smoke-test.md"), {
			force: true,
		});
	});
});
