import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
	NaturalRefinementRuntime,
	NaturalRefinementRuntimeError,
	registerNaturalRefinement,
} from "../extensions/oh-my-omp/refinement/natural";

const roots: string[] = [];

interface NaturalRefinementTool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
}

type NaturalRefinementInputHandler = (
	event: { source: string; text: string },
	ctx: {
		cwd: string;
		sessionManager: { getSessionId: () => string };
		ui: { notify: (message: string, level: string) => void };
	},
) => Promise<{ handled: true } | undefined>;

async function createProject() {
	const root = await mkdtemp(join(tmpdir(), "pantheon-natural-refinement-"));
	const stateHome = await mkdtemp(
		join(tmpdir(), "pantheon-natural-refinement-state-"),
	);
	roots.push(root, stateHome);
	await mkdir(join(root, "skills", "review"), { recursive: true });
	await writeFile(join(root, "skills", "review", "SKILL.md"), "original\n");
	await writeFile(
		join(root, "skills", "review", "SKILL.candidate.md"),
		"candidate\n",
	);
	return { root, stateHome };
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("NaturalRefinementRuntime", () => {
	test("prepares a session-scoped JSON preview without mutating the artifact or ledger", async () => {
		const { root, stateHome } = await createProject();
		const runtime = new NaturalRefinementRuntime({ stateHome });

		const preview = await runtime.preview({
			sessionId: "session-a",
			root,
			artifact: "skills/review/SKILL.md",
			candidate: "skills/review/SKILL.candidate.md",
			evidence: "evalfly:report-42",
		});

		expect(preview).toMatchObject({
			approval: "aprobar",
			sessionId: "session-a",
			artifact: "skills/review/SKILL.md",
			candidate: "skills/review/SKILL.candidate.md",
			evidence: "evalfly:report-42",
			transaction: {
				action: "activate",
				approvedBy: "user:session:session-a",
			},
		});
		expect(
			await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"),
		).toBe("original\n");
		expect(
			await Bun.file(join(root, ".pi", "refinement", "ledger.jsonl")).exists(),
		).toBe(false);
	});

	test("approves only the prepared session preview and activates the exact candidate", async () => {
		const { root, stateHome } = await createProject();
		const runtime = new NaturalRefinementRuntime({ stateHome });
		await runtime.preview({
			sessionId: "session-a",
			root,
			artifact: "skills/review/SKILL.md",
			candidate: "skills/review/SKILL.candidate.md",
			evidence: "evalfly:report-42",
		});

		const active = await runtime.approve({ sessionId: "session-a", root });

		expect(active).toMatchObject({
			status: "active",
			author: "agent:natural-refinement",
			source: "natural-refinement:session-a",
			approvedBy: "user:session:session-a",
			validationEvidence: ["evalfly:report-42"],
		});
		expect(
			await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"),
		).toBe("candidate\n");
		await expect(
			runtime.approve({ sessionId: "session-a", root }),
		).rejects.toBeInstanceOf(NaturalRefinementRuntimeError);
	});

	test("rejects approval when the candidate changed after the preview", async () => {
		const { root, stateHome } = await createProject();
		const runtime = new NaturalRefinementRuntime({ stateHome });
		await runtime.preview({
			sessionId: "session-a",
			root,
			artifact: "skills/review/SKILL.md",
			candidate: "skills/review/SKILL.candidate.md",
			evidence: "evalfly:report-42",
		});
		await writeFile(
			join(root, "skills", "review", "SKILL.candidate.md"),
			"drifted\n",
		);

		await expect(
			runtime.approve({ sessionId: "session-a", root }),
		).rejects.toThrow("candidate changed");
		expect(
			await Bun.file(join(root, ".pi", "refinement", "ledger.jsonl")).exists(),
		).toBe(false);
	});

	test("rejects approval when the artifact changed after the preview", async () => {
		const { root, stateHome } = await createProject();
		const runtime = new NaturalRefinementRuntime({ stateHome });
		await runtime.preview({
			sessionId: "session-a",
			root,
			artifact: "skills/review/SKILL.md",
			candidate: "skills/review/SKILL.candidate.md",
			evidence: "evalfly:report-42",
		});
		await writeFile(join(root, "skills", "review", "SKILL.md"), "drifted\n");

		await expect(
			runtime.approve({ sessionId: "session-a", root }),
		).rejects.toThrow("artifact changed");
		expect(
			await Bun.file(join(root, ".pi", "refinement", "ledger.jsonl")).exists(),
		).toBe(false);
	});

	test("does not let another session approve a prepared preview", async () => {
		const { root, stateHome } = await createProject();
		const runtime = new NaturalRefinementRuntime({ stateHome });
		await runtime.preview({
			sessionId: "session-a",
			root,
			artifact: "skills/review/SKILL.md",
			candidate: "skills/review/SKILL.candidate.md",
			evidence: "evalfly:report-42",
		});

		await expect(
			runtime.approve({ sessionId: "session-b", root }),
		).rejects.toThrow("No pending refinement preview");
	});

	test("does not replace an already reviewed preview", async () => {
		const { root, stateHome } = await createProject();
		const runtime = new NaturalRefinementRuntime({ stateHome });
		await writeFile(
			join(root, "skills", "review", "SKILL.second.candidate.md"),
			"second candidate\n",
		);
		await runtime.preview({
			sessionId: "session-a",
			root,
			artifact: "skills/review/SKILL.md",
			candidate: "skills/review/SKILL.candidate.md",
			evidence: "evalfly:report-42",
		});

		await expect(
			runtime.preview({
				sessionId: "session-a",
				root,
				artifact: "skills/review/SKILL.md",
				candidate: "skills/review/SKILL.second.candidate.md",
				evidence: "evalfly:report-43",
			}),
		).rejects.toThrow("pending refinement preview");
		await runtime.approve({ sessionId: "session-a", root });

		expect(
			await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"),
		).toBe("candidate\n");
	});

	test("rejects candidate paths that resolve to the artifact", async () => {
		const { root, stateHome } = await createProject();
		const runtime = new NaturalRefinementRuntime({ stateHome });

		await expect(
			runtime.preview({
				sessionId: "session-a",
				root,
				artifact: "skills/review/SKILL.md",
				candidate: "skills/review/./SKILL.md",
				evidence: "evalfly:report-42",
			}),
		).rejects.toThrow("different files");
	});
});

describe("natural refinement input approval", () => {
	test("activates only on the exact interactive approval word", async () => {
		const { root, stateHome } = await createProject();
		const tools = new Map<string, NaturalRefinementTool>();
		const inputHandlers: NaturalRefinementInputHandler[] = [];
		const schema = {
			describe: () => schema,
			optional: () => schema,
		};
		registerNaturalRefinement(
			{
				on(event: string, handler: NaturalRefinementInputHandler) {
					if (event === "input") inputHandlers.push(handler);
				},
				registerTool(tool: NaturalRefinementTool & { name: string }) {
					tools.set(tool.name, tool);
				},
				zod: {
					object: () => schema,
					string: () => schema,
				},
			} as never,
			{ stateHome },
		);
		const ctx = {
			cwd: root,
			sessionManager: { getSessionId: () => "session-a" },
			ui: { notify: () => undefined },
		};
		const preview = tools.get("refinement_preview");
		const approve = inputHandlers[0];
		expect(preview).toBeDefined();
		expect(approve).toBeDefined();
		if (!preview || !approve)
			throw new Error("Natural refinement was not registered");

		await preview.execute(
			"tool-call",
			{
				artifact: "skills/review/SKILL.md",
				candidate: "skills/review/SKILL.candidate.md",
				evidence: "evalfly:report-42",
			},
			undefined,
			undefined,
			ctx,
		);
		await expect(
			approve({ source: "interactive", text: "cancelar" }, ctx),
		).resolves.toEqual({ handled: true });
		expect(
			await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"),
		).toBe("original\n");
		await preview.execute(
			"tool-call",
			{
				artifact: "skills/review/SKILL.md",
				candidate: "skills/review/SKILL.candidate.md",
				evidence: "evalfly:report-42",
			},
			undefined,
			undefined,
			ctx,
		);
		for (const event of [
			{ source: "interactive", text: "APROBAR" },
			{ source: "interactive", text: " aprobar" },
			{ source: "interactive", text: "aprobar " },
			{ source: "agent", text: "aprobar" },
		]) {
			await expect(approve(event, ctx)).resolves.toBeUndefined();
			expect(
				await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"),
			).toBe("original\n");
		}

		await expect(
			approve({ source: "interactive", text: "aprobar" }, ctx),
		).resolves.toEqual({ handled: true });
		expect(
			await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"),
		).toBe("candidate\n");
	});
});
