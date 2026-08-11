import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CommandJournal } from "../extensions/oh-my-omp/autonomy/journal";
import { registerAutonomy } from "../extensions/oh-my-omp/autonomy/runtime";
import {
	autonomyProjectStateRoot,
	autonomyRuntimeRoot,
} from "../extensions/oh-my-omp/autonomy/runtime-paths";
import { PersistedScheduler } from "../extensions/oh-my-omp/autonomy/scheduler";
import { AutonomyStore } from "../extensions/oh-my-omp/autonomy/store";
import registerPantheon from "../extensions/oh-my-omp/index";
import { writeSpecSafeClosureReceipt } from "../extensions/oh-my-omp/specsafe-receipts";
import { writeEvalFlyEnforcementState } from "../skills/evalfly/bin/enforcement-state";

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: FakeContext) => Promise<void>;
}

interface RegisteredTool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: FakeContext,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface FakeContext {
	cwd: string;
	sessionManager?: {
		getSessionFile: () => string;
	};
	ui: {
		notify: (message: string, level: string) => void;
	};
}

type EventHandler = (event: unknown, ctx: FakeContext) => Promise<void> | void;

const roots: string[] = [];

async function writePassingEvalFlyRun(cwd: string): Promise<void> {
	const runId = "autonomy-gate-pass";
	const reportPath = `evals/reports/${runId}.md`;
	const result = {
		case_id: "autonomy-gate",
		title: "Autonomy gate",
		risk_tier: "major",
		critical: false,
		passed: true,
		privacy: { classification: "internal", sanitized: true },
		errors: [],
	};
	const run = {
		schema_version: "evalfly.run.v1",
		run_id: runId,
		suite: "smoke",
		config_name: "autonomy-test",
		created_at: "2026-08-11T22:00:01.000Z",
		context: {
			eval_report_path: reportPath,
			commit_range: "main..HEAD",
		},
		results: [result],
		summary: {
			total: 1,
			passed: 1,
			failed: 0,
			critical_regressions: 0,
		},
		verdict: "pass",
	};
	const report = [
		`# EvalFly Report ${runId}`,
		"",
		"Suite: smoke",
		"Verdict: pass",
		"Passed: 1",
		"Failed: 0",
		"critical_regressions: 0",
		"Privacy: sanitized",
		"",
		"## Context",
		"Spec-Slice: not linked",
		"Session: not linked",
		"Commit range: main..HEAD",
		`evalReportPath: ${reportPath}`,
		"",
		"## Results",
		"- PASS autonomy-gate (major)",
		"",
	].join("\n");
	await mkdir(join(cwd, "evals", "runs"), { recursive: true });
	await mkdir(join(cwd, "evals", "reports"), { recursive: true });
	await writeFile(
		join(cwd, "evals", "runs", `${runId}.json`),
		`${JSON.stringify(run)}\n`,
	);
	await writeFile(join(cwd, reportPath), report);
}
const registerTestAutonomy = (pi: never): unknown =>
	registerAutonomy(
		pi,
		{
			async verify(_cwd, command) {
				return {
					status: "pass",
					evidence: `command:${command}:exit:0`,
				};
			},
		},
		{ stateHome: (cwd) => join(cwd, ".test-state") },
	);

interface FakeExtensionOptions {
	cwd?: string;
	sessionFile?: string;
}

async function createFakeExtension(
	register: (pi: never) => unknown | Promise<unknown> = registerTestAutonomy,
	options: FakeExtensionOptions = {},
) {
	const cwd =
		options.cwd ??
		(await mkdtemp(join(tmpdir(), "pantheon-autonomy-extension-")));
	if (options.cwd === undefined) roots.push(cwd);
	const handlers: Record<string, EventHandler[]> = {};
	const commands: Record<string, RegisteredCommand> = {};
	const tools: Record<string, RegisteredTool> = {};
	const messages: string[] = [];
	const notifications: string[] = [];
	const logs: string[] = [];
	const schema = { describe: () => schema, optional: () => schema };
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands[name] = command;
		},
		registerTool(tool: RegisteredTool & { name: string }) {
			tools[tool.name] = tool;
		},
		sendUserMessage(message: string) {
			messages.push(message);
		},
		logger: {
			info(message: string) {
				logs.push(message);
			},
			debug(message: string) {
				logs.push(message);
			},
			warn(message: string) {
				logs.push(message);
			},
		},
		zod: {
			object: () => schema,
			string: () => schema,
			enum: () => schema,
			number: () => schema,
		},
	};
	await register(pi as never);
	const ctx: FakeContext = {
		cwd,
		sessionManager:
			options.sessionFile === undefined
				? undefined
				: { getSessionFile: () => options.sessionFile as string },
		ui: {
			notify(message, level) {
				notifications.push(`${level}:${message}`);
			},
		},
	};
	await handlers.session_start?.[0]?.({} as never, ctx);
	return { commands, ctx, handlers, logs, messages, notifications, tools };
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("autonomy extension", () => {
	test("registers one autonomy command and removes promise-loop commands", async () => {
		const { commands, tools } = await createFakeExtension();

		expect(Object.keys(commands)).toEqual(["autonomy"]);
		expect(commands["ralph-loop"]).toBeUndefined();
		expect(commands["ulw-loop"]).toBeUndefined();
		expect(Object.keys(tools)).toEqual(["autonomy_gate"]);
	});

	test("Pantheon entrypoint registers autonomy instead of legacy loops", async () => {
		const { commands, tools } = await createFakeExtension(registerPantheon);

		expect(Object.keys(commands)).toEqual(["autonomy"]);
		expect(Object.keys(tools)).toEqual(["autonomy_gate"]);
	});

	test("starts opt-in state and reports status", async () => {
		const { commands, ctx, messages, notifications } =
			await createFakeExtension();

		await commands.autonomy?.handler(
			'start "Ship verified autonomy" --max-attempts=2',
			ctx,
		);
		await commands.autonomy?.handler("status", ctx);

		expect(messages.at(-1)).toContain("Ship verified autonomy");
		expect(messages.at(-1)).toContain("native OMP goal");
		expect(notifications.at(-1)).toContain("running");
		expect(notifications.at(-1)).toContain("attempt 1/2");
	});

	test("completes only after native goal and verification evidence pass", async () => {
		const { commands, ctx, handlers, logs, tools } =
			await createFakeExtension();
		await commands.autonomy?.handler('start "Ship" --max-attempts=2', ctx);

		await handlers.goal_updated?.[0]?.(
			{ goal: { id: "goal-1", objective: "Ship", status: "active" } } as never,
			ctx,
		);
		await handlers.goal_updated?.[0]?.(
			{
				goal: { id: "goal-1", objective: "Ship", status: "complete" },
			} as never,
			ctx,
		);
		const result = await tools.autonomy_gate?.execute(
			"tool-1",
			{},
			new AbortController().signal,
			undefined,
			ctx,
		);
		await handlers.agent_end?.[0]?.({ messages: [] } as never, ctx);
		await commands.autonomy?.handler("status", ctx);

		expect(result?.content[0]?.text).toContain("recorded");
		expect(logs).toContain(
			"Autonomy run succeeded after objective gates passed",
		);
	});

	test("records passing EvalFly enforcement through a host gate adapter", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-evalfly-"));
		roots.push(cwd);
		writeEvalFlyEnforcementState(cwd, {
			mode: "enforced",
			suite: "smoke",
			commitRange: "main..HEAD",
			activatedAt: "2026-08-11T22:00:00.000Z",
			activatedBy: "test",
		});
		await writePassingEvalFlyRun(cwd);
		const extension = await createFakeExtension(registerTestAutonomy, { cwd });
		await extension.commands.autonomy?.handler(
			'start "Ship with EvalFly" --max-attempts=2',
			extension.ctx,
		);
		await extension.commands.autonomy?.handler("status", extension.ctx);
		expect(extension.notifications.at(-1)).toContain("evalfly=pending");
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-evalfly",
					objective: "Ship with EvalFly",
					status: "active",
				},
			},
			extension.ctx,
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-evalfly",
					objective: "Ship with EvalFly",
					status: "complete",
				},
			},
			extension.ctx,
		);
		await extension.tools.autonomy_gate?.execute(
			"verify-evalfly",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		await extension.handlers.agent_end?.[0]?.({}, extension.ctx);

		expect(extension.logs).toContain(
			"Autonomy run succeeded after objective gates passed",
		);
	});

	test("records closure of the exact SpecSafe slice through a host gate adapter", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-specsafe-"));
		roots.push(cwd);
		const statePath = join(cwd, ".pi", ".specsafe-state.json");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			statePath,
			JSON.stringify({
				currentSlice: {
					id: "SPEC-AUTONOMY",
					workspaceId: "workspace",
					sessionId: "session",
					beganAt: "2026-08-11T22:00:00.000Z",
					costCounter: {},
				},
				history: [
					{
						sliceId: "SPEC-AUTONOMY",
						beganAt: "2026-08-10T20:00:00.000Z",
						outcome: "PASS",
						endedAt: "2026-08-10T20:30:00.000Z",
					},
				],
			}),
		);
		const extension = await createFakeExtension(registerTestAutonomy, { cwd });
		await extension.commands.autonomy?.handler(
			'start "Ship with SpecSafe" --max-attempts=3',
			extension.ctx,
		);
		await extension.commands.autonomy?.handler("status", extension.ctx);
		expect(extension.notifications.at(-1)).toContain("specsafe=pending");
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-specsafe",
					objective: "Ship with SpecSafe",
					status: "active",
				},
			},
			extension.ctx,
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-specsafe",
					objective: "Ship with SpecSafe",
					status: "complete",
				},
			},
			extension.ctx,
		);
		await extension.tools.autonomy_gate?.execute(
			"verify-specsafe",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		const endedAt = new Date(Date.now() + 1_000).toISOString();
		await writeFile(
			statePath,
			JSON.stringify({
				currentSlice: null,
				history: [
					{
						sliceId: "SPEC-AUTONOMY",
						beganAt: "2026-08-10T20:00:00.000Z",
						outcome: "PASS",
						endedAt: "2026-08-10T20:30:00.000Z",
					},
					{
						sliceId: "SPEC-AUTONOMY",
						beganAt: "2026-08-11T22:00:00.000Z",
						outcome: "PASS",
						endedAt,
					},
				],
			}),
		);
		await extension.handlers.agent_end?.[0]?.({}, extension.ctx);
		expect(extension.logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);
		writeSpecSafeClosureReceipt(
			cwd,
			{
				sliceId: "SPEC-AUTONOMY",
				beganAt: "2026-08-11T22:00:00.000Z",
				endedAt,
				outcome: "PASS",
			},
			join(cwd, ".test-state"),
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-specsafe",
					objective: "Ship with SpecSafe",
					status: "active",
				},
			},
			extension.ctx,
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-specsafe",
					objective: "Ship with SpecSafe",
					status: "complete",
				},
			},
			extension.ctx,
		);
		await extension.tools.autonomy_gate?.execute(
			"verify-specsafe-after-receipt",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		await extension.handlers.agent_end?.[0]?.({}, extension.ctx);

		expect(extension.logs).toContain(
			"Autonomy run succeeded after objective gates passed",
		);
	});

	test("rejects a private SpecSafe receipt created before gate activation", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-specsafe-replay-"),
		);
		roots.push(cwd);
		const beganAt = new Date(Date.now() - 10_000).toISOString();
		const endedAt = new Date(Date.now() - 5_000).toISOString();
		const statePath = join(cwd, ".pi", ".specsafe-state.json");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			statePath,
			JSON.stringify({
				currentSlice: {
					id: "SPEC-REPLAY",
					workspaceId: "workspace",
					sessionId: "session",
					beganAt,
					costCounter: {},
				},
				history: [],
			}),
		);
		writeSpecSafeClosureReceipt(
			cwd,
			{ sliceId: "SPEC-REPLAY", beganAt, endedAt, outcome: "PASS" },
			join(cwd, ".test-state"),
		);
		const extension = await createFakeExtension(registerTestAutonomy, { cwd });
		await extension.commands.autonomy?.handler(
			'start "Reject replay" --max-attempts=1',
			extension.ctx,
		);
		await writeFile(
			statePath,
			JSON.stringify({
				currentSlice: null,
				history: [
					{
						sliceId: "SPEC-REPLAY",
						beganAt,
						endedAt,
						outcome: "PASS",
					},
				],
			}),
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-specsafe-replay",
					objective: "Reject replay",
					status: "active",
				},
			},
			extension.ctx,
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-specsafe-replay",
					objective: "Reject replay",
					status: "complete",
				},
			},
			extension.ctx,
		);
		await extension.tools.autonomy_gate?.execute(
			"verify-specsafe-replay",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		await extension.handlers.agent_end?.[0]?.({}, extension.ctx);

		expect(extension.logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);
		expect(extension.logs).toContain(
			"Autonomy run failed at its maximum attempt bound",
		);
	});

	test("fails closed when configured EvalFly evidence is unavailable", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-evalfly-"));
		roots.push(cwd);
		writeEvalFlyEnforcementState(cwd, {
			mode: "enforced",
			suite: "smoke",
			commitRange: "main..HEAD",
			activatedAt: "2026-08-11T22:00:00.000Z",
			activatedBy: "test",
		});
		const extension = await createFakeExtension(registerTestAutonomy, { cwd });
		await extension.commands.autonomy?.handler(
			'start "Ship without evidence" --max-attempts=2',
			extension.ctx,
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-missing-eval",
					objective: "Ship without evidence",
					status: "active",
				},
			},
			extension.ctx,
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "goal-missing-eval",
					objective: "Ship without evidence",
					status: "complete",
				},
			},
			extension.ctx,
		);
		await extension.tools.autonomy_gate?.execute(
			"verify-missing-eval",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		await extension.handlers.agent_end?.[0]?.({}, extension.ctx);

		expect(extension.logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);
		expect(extension.messages.at(-1)).toContain("evalfly");
	});

	test("rejects malformed configured gate state before starting", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-gates-"));
		roots.push(cwd);
		await mkdir(join(cwd, ".pi", "evalfly"), { recursive: true });
		await writeFile(join(cwd, ".pi", "evalfly", "enforcement.json"), "{bad");
		const extension = await createFakeExtension(registerTestAutonomy, { cwd });

		await extension.commands.autonomy?.handler(
			'start "Unsafe state"',
			extension.ctx,
		);

		expect(extension.notifications.at(-1)).toStartWith("error:");
		expect(extension.messages).toHaveLength(0);
	});

	test("binds the native gate to the matching active goal and ignores unrelated completion", async () => {
		const { commands, ctx, handlers, logs, messages, tools } =
			await createFakeExtension();
		await commands.autonomy?.handler('start "Ship A" --max-attempts=2', ctx);

		await handlers.goal_updated?.[0]?.(
			{
				goal: { id: "goal-a", objective: "Ship A", status: "active" },
			} as never,
			ctx,
		);
		await handlers.goal_updated?.[0]?.(
			{
				goal: { id: "goal-b", objective: "Unrelated", status: "complete" },
			} as never,
			ctx,
		);
		await tools.autonomy_gate?.execute("tool-1", {}, undefined, undefined, ctx);
		await handlers.agent_end?.[0]?.({ messages: [] } as never, ctx);

		expect(logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);
		expect(messages.at(-1)).toContain("native-goal");
	});

	test("does not let model-facing tool parameters attest the native goal gate", async () => {
		const { commands, ctx, handlers, logs, messages, tools } =
			await createFakeExtension();
		await commands.autonomy?.handler('start "Ship" --max-attempts=2', ctx);

		await tools.autonomy_gate?.execute(
			"tool-1",
			{
				gateId: "native-goal",
				status: "pass",
				evidence: "self-attested",
			},
			undefined,
			undefined,
			ctx,
		);
		await handlers.agent_end?.[0]?.({ messages: [] } as never, ctx);

		expect(logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);
		expect(messages.at(-1)).toContain("native-goal");
	});

	test("ignores completion promises and continues with missing gates", async () => {
		const { commands, ctx, handlers, messages, notifications } =
			await createFakeExtension();
		await commands.autonomy?.handler('start "Ship" --max-attempts=2', ctx);

		await handlers.agent_end?.[0]?.(
			{ messages: [{ content: "<promise>DONE</promise>" }] } as never,
			ctx,
		);
		await commands.autonomy?.handler("status", ctx);

		expect(messages.at(-1)).toContain("native-goal, verification");
		expect(notifications.at(-1)).toContain("attempt 2/2");
		expect(notifications.at(-1)).not.toContain("succeeded");
	});

	test("pause stops the worker and blocks verification until resume", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-pause-"));
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-pause-state-"),
		);
		roots.push(cwd, stateHome);
		const sessionFile = join(cwd, "session.jsonl");
		const starts: string[] = [];
		const stops: string[] = [];
		let verificationCalls = 0;
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							verificationCalls += 1;
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						now: () => "2026-08-11T22:30:00.000Z",
						agentdFactory: () => ({
							async start(runId) {
								starts.push(runId);
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop(runId) {
								stops.push(runId);
								return { state: "stopped", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile },
		);
		await extension.commands.autonomy?.handler(
			'start "Pause safely" --max-attempts=3',
			extension.ctx,
		);
		await extension.handlers.agent_end?.[0]?.({ messages: [] }, extension.ctx);
		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
		const running = await new AutonomyStore(cwd, { stateDirectory }).load();
		if (running === null) throw new Error("Expected autonomy state");
		const runtimeRoot = autonomyRuntimeRoot(cwd, running.id, stateHome);
		const journal = new CommandJournal(runtimeRoot, {
			expectedRunId: running.id,
			expectedCwd: cwd,
		});
		expect(
			await new PersistedScheduler(runtimeRoot, journal).list(),
		).toHaveLength(1);

		await extension.commands.autonomy?.handler("pause", extension.ctx);

		expect(stops).toEqual([running.id]);
		expect(
			(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
		).toBe("paused");
		await expect(
			extension.tools.autonomy_gate?.execute(
				"paused-verification",
				{},
				undefined,
				undefined,
				extension.ctx,
			),
		).rejects.toThrow("paused");
		expect(verificationCalls).toBe(0);

		await extension.commands.autonomy?.handler("resume", extension.ctx);

		expect(starts).toEqual([running.id, running.id]);
		expect(
			(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
		).toBe("running");
		expect(
			await new PersistedScheduler(runtimeRoot, journal).list(),
		).toHaveLength(1);
	});

	test("paused mutations invalidate gate evidence without resuming execution", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-paused-write-"),
		);
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-paused-write-state-"),
		);
		roots.push(cwd, stateHome);
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						agentdFactory: () => ({
							async start() {
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop() {
								return { state: "stopped", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile: join(cwd, "session.jsonl") },
		);
		await extension.commands.autonomy?.handler(
			'start "Invalidate paused evidence" --max-attempts=2',
			extension.ctx,
		);
		await extension.tools.autonomy_gate?.execute(
			"running-verification",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
		const verified = await new AutonomyStore(cwd, { stateDirectory }).load();
		if (verified === null) throw new Error("Expected verified autonomy state");
		expect(
			verified.gates.find((gate) => gate.id === "verification")?.status,
		).toBe("pass");
		await extension.commands.autonomy?.handler("pause", extension.ctx);

		await extension.handlers.tool_result?.[0]?.(
			{
				toolCallId: "paused-write",
				toolName: "write",
				input: { path: "artifact.txt" },
				isError: false,
			},
			extension.ctx,
		);

		const invalidated = await new AutonomyStore(cwd, {
			stateDirectory,
		}).load();
		if (invalidated === null)
			throw new Error("Expected invalidated autonomy state");
		expect(invalidated.status).toBe("paused");
		expect(invalidated.artifactRevision).toBe(verified.artifactRevision + 1);
		expect(
			invalidated.gates.every(
				(gate) => gate.status === "pending" && gate.evidence === undefined,
			),
		).toBe(true);
		await extension.commands.autonomy?.handler("resume", extension.ctx);
		const resumed = await new AutonomyStore(cwd, { stateDirectory }).load();
		expect(resumed?.status).toBe("running");
		expect(resumed?.artifactRevision).toBe(invalidated.artifactRevision);
		expect(resumed?.gates.every((gate) => gate.status === "pending")).toBe(
			true,
		);
	});

	test("does not persist pause until the worker confirms a terminal stop", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-pause-stop-"));
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-pause-stop-state-"),
		);
		roots.push(cwd, stateHome);
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						agentdFactory: () => ({
							async start() {
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop() {
								return { state: "stopping", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile: join(cwd, "session.jsonl") },
		);
		await extension.commands.autonomy?.handler(
			'start "Pause only after stop" --max-attempts=2',
			extension.ctx,
		);

		await extension.commands.autonomy?.handler("pause", extension.ctx);

		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
		expect(
			(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
		).toBe("running");
		expect(extension.notifications.at(-1)).toContain(
			"worker stop is not terminal",
		);
		expect(extension.notifications).not.toContain("Autonomy paused.");
	});

	test("does not persist cancellation until the worker confirms a terminal stop", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-cancel-stop-"));
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-cancel-stop-state-"),
		);
		roots.push(cwd, stateHome);
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						agentdFactory: () => ({
							async start() {
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop() {
								return { state: "stopping", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile: join(cwd, "session.jsonl") },
		);
		await extension.commands.autonomy?.handler(
			'start "Cancel only after stop" --max-attempts=2',
			extension.ctx,
		);

		await extension.commands.autonomy?.handler("cancel", extension.ctx);

		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
		expect(
			(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
		).toBe("running");
		expect(extension.notifications.at(-1)).toContain(
			"worker stop is not terminal",
		);
		expect(extension.notifications).not.toContain("Autonomy cancelled.");
	});

	test("does not persist cancellation when stopping the worker throws", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-cancel-error-"),
		);
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-cancel-error-state-"),
		);
		roots.push(cwd, stateHome);
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						agentdFactory: () => ({
							async start() {
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop(): Promise<never> {
								throw new Error("broker stop failed");
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile: join(cwd, "session.jsonl") },
		);
		await extension.commands.autonomy?.handler(
			'start "Cancel after broker stop" --max-attempts=2',
			extension.ctx,
		);

		await extension.commands.autonomy?.handler("cancel", extension.ctx);

		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
		expect(
			(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
		).toBe("running");
		expect(extension.notifications.at(-1)).toContain("broker stop failed");
		expect(extension.notifications).not.toContain("Autonomy cancelled.");
	});

	test("queues a persistent continuation and resumes its daemon in a new session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-project-"));
		const stateHome = await mkdtemp(join(tmpdir(), "pantheon-autonomy-state-"));
		roots.push(cwd, stateHome);
		const sessionFile = join(cwd, "session.jsonl");
		const firstStarts: string[] = [];
		const firstStops: string[] = [];
		const first = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						now: () => "2026-08-11T22:30:00.000Z",
						agentdFactory: () => ({
							async start(runId) {
								firstStarts.push(runId);
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop(runId) {
								firstStops.push(runId);
								return { state: "stopped", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile },
		);

		await first.commands.autonomy?.handler(
			'start "Ship persistently" --max-attempts=3',
			first.ctx,
		);
		await first.handlers.agent_end?.[0]?.({ messages: [] }, first.ctx);
		await first.handlers.session_shutdown?.[0]?.({}, first.ctx);

		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
		const state = await new AutonomyStore(cwd, { stateDirectory }).load();
		if (state === null) throw new Error("Expected persisted autonomy state");
		expect(state?.status).toBe("running");
		expect(state?.attempt).toBe(2);
		expect(firstStarts).toEqual([state.id]);
		expect(firstStops).toEqual([]);

		const runtimeRoot = autonomyRuntimeRoot(cwd, state.id, stateHome);
		const journal = new CommandJournal(runtimeRoot, {
			expectedRunId: state.id,
			expectedCwd: cwd,
		});
		const schedules = await new PersistedScheduler(runtimeRoot, journal).list();
		expect(schedules).toHaveLength(1);
		expect(schedules[0]?.request.command).toMatchObject({
			runId: state.id,
			cwd,
			sessionFile,
			maxAttempts: 3,
		});

		const secondStarts: string[] = [];
		await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						agentdFactory: () => ({
							async start(runId) {
								secondStarts.push(runId);
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop() {
								return { state: "stopped", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile },
		);
		expect(secondStarts).toEqual([state.id]);
	});

	test("invalidates completed gates after a successful mutating tool result", async () => {
		const { commands, ctx, handlers, logs, messages, tools } =
			await createFakeExtension();
		await commands.autonomy?.handler('start "Ship" --max-attempts=2', ctx);
		await handlers.goal_updated?.[0]?.(
			{ goal: { id: "goal-1", objective: "Ship", status: "active" } },
			ctx,
		);
		await handlers.goal_updated?.[0]?.(
			{ goal: { id: "goal-1", objective: "Ship", status: "complete" } },
			ctx,
		);
		await tools.autonomy_gate?.execute(
			"verification-1",
			{},
			undefined,
			undefined,
			ctx,
		);

		await handlers.tool_result?.[0]?.(
			{
				toolCallId: "write-1",
				toolName: "write",
				input: { path: "src/result.ts" },
				isError: false,
			},
			ctx,
		);
		await handlers.agent_end?.[0]?.({ messages: [] }, ctx);

		expect(logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);
		expect(messages.at(-1)).toContain("native-goal, verification");
	});

	test("keeps native goal evidence across the goal control tool result", async () => {
		const { commands, ctx, handlers, logs, tools } =
			await createFakeExtension();
		await commands.autonomy?.handler('start "Ship" --max-attempts=2', ctx);
		await handlers.goal_updated?.[0]?.(
			{ goal: { id: "goal-1", objective: "Ship", status: "active" } },
			ctx,
		);
		await handlers.goal_updated?.[0]?.(
			{ goal: { id: "goal-1", objective: "Ship", status: "complete" } },
			ctx,
		);
		await handlers.tool_result?.[0]?.(
			{
				toolCallId: "goal-1",
				toolName: "goal",
				input: { op: "complete", id: "goal-1" },
				isError: false,
			},
			ctx,
		);
		await tools.autonomy_gate?.execute(
			"verification-1",
			{},
			undefined,
			undefined,
			ctx,
		);
		await handlers.agent_end?.[0]?.({ messages: [] }, ctx);

		expect(logs).toContain(
			"Autonomy run succeeded after objective gates passed",
		);
	});

	test("invalidates completed gates after a failed mutating tool result", async () => {
		const { commands, ctx, handlers, logs, messages, tools } =
			await createFakeExtension();
		await commands.autonomy?.handler('start "Ship" --max-attempts=2', ctx);
		await handlers.goal_updated?.[0]?.(
			{ goal: { id: "goal-1", objective: "Ship", status: "active" } },
			ctx,
		);
		await handlers.goal_updated?.[0]?.(
			{ goal: { id: "goal-1", objective: "Ship", status: "complete" } },
			ctx,
		);
		await tools.autonomy_gate?.execute(
			"verification-1",
			{},
			undefined,
			undefined,
			ctx,
		);
		await handlers.tool_result?.[0]?.(
			{
				toolCallId: "bash-1",
				toolName: "bash",
				input: { command: "printf bad >> artifact && false" },
				isError: true,
			},
			ctx,
		);
		await handlers.agent_end?.[0]?.({ messages: [] }, ctx);

		expect(logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);
		expect(messages.at(-1)).toContain("native-goal, verification");
	});

	test("creates persistent autonomy state with private modes", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-project-"));
		const stateHome = await mkdtemp(join(tmpdir(), "pantheon-autonomy-state-"));
		roots.push(cwd, stateHome);
		const sessionFile = join(cwd, "session.jsonl");
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify(_cwd, command) {
							return {
								status: "pass",
								evidence: `command:${command}:exit:0`,
							};
						},
					},
					{
						stateHome,
						agentdFactory: () => ({
							async start() {
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "ready", restartCount: 0 };
							},
							async stop() {
								return { state: "stopped", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile },
		);
		await extension.commands.autonomy?.handler(
			'start "Private state" --max-attempts=2',
			extension.ctx,
		);
		await extension.handlers.agent_end?.[0]?.({ messages: [] }, extension.ctx);

		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
		const state = await new AutonomyStore(cwd, { stateDirectory }).load();
		const runtimeRoot = autonomyRuntimeRoot(cwd, state?.id ?? "", stateHome);
		for (const directory of [
			stateDirectory,
			runtimeRoot,
			join(runtimeRoot, "scheduler"),
			join(runtimeRoot, "scheduler", "generations"),
			join(runtimeRoot, "scheduler", "generations", "1"),
		]) {
			expect((await stat(directory)).mode & 0o777).toBe(0o700);
		}
		for (const file of [
			join(stateDirectory, "state.json"),
			join(stateDirectory, "events.jsonl"),
			join(runtimeRoot, "scheduler", "manifest.json"),
			join(runtimeRoot, "scheduler", "generations", "1", "snapshot.json"),
			join(runtimeRoot, "scheduler", "generations", "1", "events.jsonl"),
		]) {
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		}
	});
});
