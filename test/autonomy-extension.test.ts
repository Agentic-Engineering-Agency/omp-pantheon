import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { AutonomyController } from "../extensions/oh-my-omp/autonomy/controller";
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

const TERMINAL_STOP_FAILURES = [
	{
		name: "the broker returns a nonterminal state",
		message: "worker stop is not terminal",
		async stop() {
			return { state: "stopping", restartCount: 0 };
		},
	},
	{
		name: "the broker stop throws",
		message: "broker stop failed",
		async stop(): Promise<never> {
			throw new Error("broker stop failed");
		},
	},
];

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

async function loadTestState(cwd: string) {
	return new AutonomyStore(cwd, {
		stateDirectory: autonomyProjectStateRoot(cwd, join(cwd, ".test-state")),
	}).load();
}

interface FakeExtensionOptions {
	cwd?: string;
	sessionFile?: string | null;
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
	const sessionFile =
		options.sessionFile === undefined
			? join(cwd, "session.jsonl")
			: options.sessionFile;
	const ctx: FakeContext = {
		cwd,
		sessionManager:
			sessionFile === null ? undefined : { getSessionFile: () => sessionFile },
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

	test("rejects start without a persisted OMP session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-no-session-"));
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-no-session-state-"),
		);
		roots.push(cwd, stateHome);
		let starts = 0;
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify() {
							return { status: "pass", evidence: "exit:0" };
						},
					},
					{
						stateHome,
						agentdFactory: () => ({
							async start() {
								starts += 1;
								return { state: "ready", restartCount: 0 };
							},
							async status() {
								return { state: "stopped", restartCount: 0 };
							},
							async stop() {
								return { state: "stopped", restartCount: 0 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile: null },
		);

		await extension.commands.autonomy?.handler(
			'start "Must remain owned"',
			extension.ctx,
		);

		expect(extension.notifications.at(-1)).toContain("persisted OMP session");
		expect(starts).toBe(0);
		expect(
			await new AutonomyStore(cwd, {
				stateDirectory: autonomyProjectStateRoot(cwd, stateHome),
			}).load(),
		).toBeNull();
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

	test("binds evidence and continuation to the owning session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-owner-"));
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-owner-state-"),
		);
		roots.push(cwd, stateHome);
		const ownerSession = join(cwd, "owner.jsonl");
		const otherSession = join(cwd, "other.jsonl");
		const owner = await createFakeExtension(
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
			{ cwd, sessionFile: ownerSession },
		);
		await owner.commands.autonomy?.handler(
			'start "Own this session" --max-attempts=2',
			owner.ctx,
		);
		const other = await createFakeExtension(
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
			{ cwd, sessionFile: otherSession },
		);
		const store = new AutonomyStore(cwd, {
			stateDirectory: autonomyProjectStateRoot(cwd, stateHome),
		});
		const before = await store.load();
		if (before === null) throw new Error("Expected owned autonomy run");

		await other.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "other-goal",
					objective: "Own this session",
					status: "active",
				},
			},
			other.ctx,
		);
		expect(await store.load()).toEqual(before);

		await other.handlers.tool_result?.[0]?.(
			{
				toolCallId: "other-write",
				toolName: "write",
				input: { path: "other.txt" },
				isError: false,
			},
			other.ctx,
		);
		await other.handlers.agent_end?.[0]?.({ messages: [] }, other.ctx);
		await expect(
			other.tools.autonomy_gate?.execute(
				"other-verification",
				{},
				undefined,
				undefined,
				other.ctx,
			),
		).rejects.toThrow("does not own");

		const invalidated = await store.load();
		expect(invalidated).toMatchObject({
			attempt: before.attempt,
			artifactRevision: before.artifactRevision + 1,
		});
		expect(invalidated?.gates.every((gate) => gate.status === "pending")).toBe(
			true,
		);

		const invalidatedAttempt = invalidated?.attempt;
		await owner.handlers.agent_end?.[0]?.({ messages: [] }, owner.ctx);
		const advanced = await store.load();
		if (advanced === null) throw new Error("Expected advanced autonomy run");
		expect(advanced).toMatchObject({
			ownerSessionFile: ownerSession,
			attempt: (invalidatedAttempt ?? 1) + 1,
		});
		const root = autonomyRuntimeRoot(cwd, advanced.id, stateHome);
		const commandJournal = new CommandJournal(root, {
			expectedRunId: advanced.id,
			expectedCwd: cwd,
		});
		const scheduler = new PersistedScheduler(root, commandJournal);
		expect((await scheduler.list())[0]?.request.command.sessionFile).toBe(
			ownerSession,
		);
	});

	test("uses each event context after a same-runtime session switch", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-context-session-"),
		);
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-context-session-state-"),
		);
		roots.push(cwd, stateHome);
		const ownerSession = join(cwd, "owner.jsonl");
		const otherSession = join(cwd, "other.jsonl");
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
			{ cwd, sessionFile: ownerSession },
		);
		await extension.commands.autonomy?.handler(
			'start "Context-owned objective" --max-attempts=2',
			extension.ctx,
		);
		const otherCtx: FakeContext = {
			...extension.ctx,
			sessionManager: { getSessionFile: () => otherSession },
		};
		await extension.handlers.session_switch?.[0]?.({}, otherCtx);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "other-goal",
					objective: "Context-owned objective",
					status: "active",
				},
			},
			otherCtx,
		);
		const store = new AutonomyStore(cwd, {
			stateDirectory: autonomyProjectStateRoot(cwd, stateHome),
		});
		expect((await store.load())?.nativeGoalId).toBeUndefined();

		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "owner-goal",
					objective: "Context-owned objective",
					status: "active",
				},
			},
			extension.ctx,
		);
		await extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "owner-goal",
					objective: "Context-owned objective",
					status: "complete",
				},
			},
			extension.ctx,
		);
		await extension.tools.autonomy_gate?.execute(
			"owner-verification",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		await extension.handlers.session_switch?.[0]?.({}, otherCtx);
		await extension.handlers.agent_end?.[0]?.({ messages: [] }, extension.ctx);

		expect(await store.load()).toMatchObject({
			status: "succeeded",
			nativeGoalId: "owner-goal",
			ownerSessionFile: ownerSession,
		});
	});

	test("rejects stale verification evidence after run replacement", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-verify-race-"));
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-verify-race-state-"),
		);
		roots.push(cwd, stateHome);
		const sessionFile = join(cwd, "session.jsonl");
		let resolveVerification:
			| ((receipt: { status: "pass"; evidence: string }) => void)
			| undefined;
		const extension = await createFakeExtension(
			(pi) =>
				registerAutonomy(
					pi,
					{
						async verify() {
							return await new Promise((resolve) => {
								resolveVerification = resolve;
							});
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
			'start "Verify run one" --max-attempts=2',
			extension.ctx,
		);
		const verification = extension.tools.autonomy_gate?.execute(
			"racing-verification",
			{},
			undefined,
			undefined,
			extension.ctx,
		);
		const store = new AutonomyStore(cwd, {
			stateDirectory: autonomyProjectStateRoot(cwd, stateHome),
		});
		const controller = new AutonomyController(store);
		const original = await controller.get();
		if (original === null) throw new Error("Expected original run");
		await controller.cancel(original.id);
		await new AutonomyController(store, {
			createId: () => "replacement-verification-run",
		}).start({
			task: "Replacement verification run",
			maxAttempts: 2,
			verificationCommand: "bun test",
			ownerSessionFile: sessionFile,
			gates: [
				{
					id: "verification",
					label: "Targeted verification",
					requirement: { kind: "command" },
				},
			],
		});
		resolveVerification?.({
			status: "pass",
			evidence: "command:stale:exit:0",
		});
		await expect(verification).rejects.toThrow("autonomy run changed");
		expect(
			(await store.load())?.gates.find((gate) => gate.id === "verification")
				?.status,
		).toBe("pending");
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
		expect((await loadTestState(extension.ctx.cwd))?.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "evalfly", status: "pending" }),
			]),
		);
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
		expect((await loadTestState(ctx.cwd))?.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "native-goal", status: "pending" }),
			]),
		);
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
		expect((await loadTestState(ctx.cwd))?.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "native-goal", status: "pending" }),
			]),
		);
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

		expect(
			(await loadTestState(ctx.cwd))?.gates.every(
				(gate) => gate.status === "pending",
			),
		).toBe(true);
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

	test("accepts failed broker state as terminal for pause and cancellation", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-failed-stop-"));
		const stateHome = await mkdtemp(
			join(tmpdir(), "pantheon-autonomy-failed-stop-state-"),
		);
		roots.push(cwd, stateHome);
		let stopCalls = 0;
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
								return { state: "failed", restartCount: 3 };
							},
							async stop() {
								stopCalls += 1;
								return { state: "failed", restartCount: 3 };
							},
							close() {},
						}),
					},
				),
			{ cwd, sessionFile: join(cwd, "session.jsonl") },
		);
		await extension.commands.autonomy?.handler(
			'start "Fence failed worker" --max-attempts=2',
			extension.ctx,
		);
		const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);

		await extension.commands.autonomy?.handler("pause", extension.ctx);

		expect(
			(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
		).toBe("paused");
		expect(extension.notifications.at(-1)).toBe("info:Autonomy paused.");

		await extension.commands.autonomy?.handler("cancel", extension.ctx);

		expect(
			(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
		).toBe("cancelled");
		expect(extension.notifications.at(-1)).toBe("info:Autonomy cancelled.");
		expect(stopCalls).toBe(2);
	});

	for (const scenario of TERMINAL_STOP_FAILURES) {
		test(`does not persist successful completion when ${scenario.name}`, async () => {
			const cwd = await mkdtemp(
				join(tmpdir(), "pantheon-autonomy-success-stop-"),
			);
			const stateHome = await mkdtemp(
				join(tmpdir(), "pantheon-autonomy-success-stop-state-"),
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
									return scenario.stop();
								},
								close() {},
							}),
						},
					),
				{ cwd, sessionFile: join(cwd, "session.jsonl") },
			);
			await extension.commands.autonomy?.handler(
				'start "Fence success" --max-attempts=2',
				extension.ctx,
			);
			await extension.handlers.goal_updated?.[0]?.(
				{
					goal: {
						id: "goal-success",
						objective: "Fence success",
						status: "active",
					},
				},
				extension.ctx,
			);
			await extension.handlers.goal_updated?.[0]?.(
				{
					goal: {
						id: "goal-success",
						objective: "Fence success",
						status: "complete",
					},
				},
				extension.ctx,
			);
			await extension.tools.autonomy_gate?.execute(
				"success-verification",
				{},
				undefined,
				undefined,
				extension.ctx,
			);

			await expect(
				extension.handlers.agent_end?.[0]?.({ messages: [] }, extension.ctx),
			).rejects.toThrow(scenario.message);

			const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
			expect(
				(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
			).not.toBe("succeeded");
			expect(extension.logs).not.toContain(
				"Autonomy run succeeded after objective gates passed",
			);
		});

		test(`does not persist attempt-bound failure when ${scenario.name}`, async () => {
			const cwd = await mkdtemp(
				join(tmpdir(), "pantheon-autonomy-failure-stop-"),
			);
			const stateHome = await mkdtemp(
				join(tmpdir(), "pantheon-autonomy-failure-stop-state-"),
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
									return scenario.stop();
								},
								close() {},
							}),
						},
					),
				{ cwd, sessionFile: join(cwd, "session.jsonl") },
			);
			await extension.commands.autonomy?.handler(
				'start "Fence failure" --max-attempts=1',
				extension.ctx,
			);

			await expect(
				extension.handlers.agent_end?.[0]?.({ messages: [] }, extension.ctx),
			).rejects.toThrow(scenario.message);

			const stateDirectory = autonomyProjectStateRoot(cwd, stateHome);
			expect(
				(await new AutonomyStore(cwd, { stateDirectory }).load())?.status,
			).not.toBe("failed");
			expect(extension.logs).not.toContain(
				"Autonomy run failed at its maximum attempt bound",
			);
		});
	}

	test("resident worker records terminal intent without stopping its own daemon", async () => {
		const createResidentExtension = async (
			prefix: string,
		): Promise<{
			extension: Awaited<ReturnType<typeof createFakeExtension>>;
			cwd: string;
			stateHome: string;
			stopCalls: () => number;
		}> => {
			const cwd = await mkdtemp(join(tmpdir(), `pantheon-${prefix}-`));
			const stateHome = await mkdtemp(
				join(tmpdir(), `pantheon-${prefix}-state-`),
			);
			roots.push(cwd, stateHome);
			let stops = 0;
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
							isResidentWorker: () => true,
							residentCommandId: () => "resident-command",
							agentdFactory: () => ({
								async start() {
									return { state: "ready", restartCount: 0 };
								},
								async status() {
									return { state: "ready", restartCount: 0 };
								},
								async stop() {
									stops += 1;
									throw new Error("resident worker must not stop itself");
								},
								close() {},
							}),
						},
					),
				{ cwd, sessionFile: join(cwd, "session.jsonl") },
			);
			return { extension, cwd, stateHome, stopCalls: () => stops };
		};

		const success = await createResidentExtension("resident-success");
		await success.extension.commands.autonomy?.handler(
			'start "Resident success" --max-attempts=2',
			success.extension.ctx,
		);
		await success.extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "resident-goal",
					objective: "Resident success",
					status: "active",
				},
			},
			success.extension.ctx,
		);
		await success.extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "resident-goal",
					objective: "Resident success",
					status: "complete",
				},
			},
			success.extension.ctx,
		);
		await success.extension.tools.autonomy_gate?.execute(
			"resident-verification",
			{},
			undefined,
			undefined,
			success.extension.ctx,
		);
		await success.extension.handlers.agent_end?.[0]?.(
			{ messages: [] },
			success.extension.ctx,
		);
		await success.extension.handlers.session_shutdown?.[0]?.(
			{},
			success.extension.ctx,
		);
		const successState = await new AutonomyStore(success.cwd, {
			stateDirectory: autonomyProjectStateRoot(success.cwd, success.stateHome),
		}).load();
		expect(successState?.status).toBe("running");
		expect(successState?.terminalIntent).toMatchObject({
			status: "succeeded",
			commandId: "resident-command",
		});
		expect(success.stopCalls()).toBe(0);

		const failure = await createResidentExtension("resident-failure");
		await failure.extension.commands.autonomy?.handler(
			'start "Resident failure" --max-attempts=1',
			failure.extension.ctx,
		);
		await failure.extension.handlers.agent_end?.[0]?.(
			{ messages: [] },
			failure.extension.ctx,
		);
		await failure.extension.handlers.session_shutdown?.[0]?.(
			{},
			failure.extension.ctx,
		);
		const failureState = await new AutonomyStore(failure.cwd, {
			stateDirectory: autonomyProjectStateRoot(failure.cwd, failure.stateHome),
		}).load();
		expect(failureState?.status).toBe("running");
		expect(failureState?.terminalIntent).toMatchObject({
			status: "failed",
			commandId: "resident-command",
		});
		expect(failure.stopCalls()).toBe(0);
	});

	test("external terminal paths cannot bypass a resident terminal intent", async () => {
		const createExternalExtension = async (
			prefix: string,
			task: string,
			maxAttempts = 1,
		) => {
			const cwd = await mkdtemp(join(tmpdir(), `pantheon-${prefix}-`));
			const stateHome = await mkdtemp(
				join(tmpdir(), `pantheon-${prefix}-state-`),
			);
			roots.push(cwd, stateHome);
			let stops = 0;
			let onStop: (() => Promise<void>) | undefined;
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
									stops += 1;
									await onStop?.();
									return { state: "stopped", restartCount: 0 };
								},
								close() {},
							}),
						},
					),
				{ cwd, sessionFile },
			);
			await extension.commands.autonomy?.handler(
				`start "${task}" --max-attempts=${maxAttempts}`,
				extension.ctx,
			);
			const store = new AutonomyStore(cwd, {
				stateDirectory: autonomyProjectStateRoot(cwd, stateHome),
			});
			const state = await store.load();
			if (state === null) throw new Error("Expected autonomy state");
			const controller = new AutonomyController(store);
			const journal = new CommandJournal(
				autonomyRuntimeRoot(cwd, state.id, stateHome),
				{ expectedRunId: state.id, expectedCwd: cwd },
			);
			const workerCommand = (id: string) => ({
				schemaVersion: 1 as const,
				id,
				runId: state.id,
				cwd,
				sessionFile,
				prompt: "Continue the verified objective.",
				maxAttempts: 3,
				createdAt: "2026-08-11T23:45:00.000Z",
			});
			return {
				controller,
				cwd,
				extension,
				journal,
				stateHome,
				setStopAction(action: () => Promise<void>) {
					onStop = action;
				},
				stopCalls: () => stops,
				store,
				workerCommand,
			};
		};

		const pause = await createExternalExtension(
			"external-pending-pause",
			"External pending pause",
		);
		await pause.journal.enqueue(pause.workerCommand("pause-command"));
		await pause.controller.requestTerminalIntent("cancelled", "pause-command");
		await pause.extension.commands.autonomy?.handler(
			"pause",
			pause.extension.ctx,
		);
		expect(await pause.store.load()).toMatchObject({
			status: "failed",
			lastError:
				"Terminal transition persistence is queued: command was not durably acknowledged",
		});
		expect(pause.stopCalls()).toBe(1);
		expect(pause.extension.notifications.at(-1)).toContain(
			"Pending terminal transition resolved as failed",
		);

		const cancel = await createExternalExtension(
			"external-pending-cancel",
			"External pending cancel",
		);
		await cancel.journal.enqueue(cancel.workerCommand("cancel-command"));
		await cancel.journal.claimNext("resident-worker", 5_000);
		await cancel.controller.requestTerminalIntent("paused", "cancel-command");
		await cancel.extension.commands.autonomy?.handler(
			"cancel",
			cancel.extension.ctx,
		);
		expect((await cancel.journal.list())[0]?.status).toBe("uncertain");
		expect((await cancel.store.load())?.status).toBe("failed");
		expect(cancel.stopCalls()).toBe(1);
		expect(cancel.extension.notifications.at(-1)).toContain(
			"cancellation was not applied",
		);

		const lateIntent = await createExternalExtension(
			"external-late-intent",
			"Reconcile intent created during stop",
		);
		await lateIntent.journal.enqueue(
			lateIntent.workerCommand("late-intent-command"),
		);
		lateIntent.setStopAction(async () => {
			await lateIntent.controller.requestTerminalIntent(
				"cancelled",
				"late-intent-command",
			);
		});
		await lateIntent.extension.commands.autonomy?.handler(
			"pause",
			lateIntent.extension.ctx,
		);
		expect(await lateIntent.store.load()).toMatchObject({
			status: "failed",
			lastError:
				"Terminal transition persistence is queued: command was not durably acknowledged",
		});
		expect((await lateIntent.store.load())?.terminalIntent).toBeUndefined();
		expect(lateIntent.stopCalls()).toBe(1);
		expect(lateIntent.extension.notifications.at(-1)).toContain(
			"Pending terminal transition resolved as failed",
		);

		const replacement = await createExternalExtension(
			"external-replacement-run",
			"Fence replacement run",
		);
		replacement.setStopAction(async () => {
			await replacement.controller.cancel();
			await new AutonomyController(replacement.store, {
				createId: () => "replacement-run",
			}).start({
				task: "Replacement run",
				maxAttempts: 2,
				verificationCommand: "bun test",
				ownerSessionFile: join(replacement.cwd, "replacement.jsonl"),
				gates: [
					{
						id: "native-goal",
						label: "OMP native goal",
						requirement: { kind: "native-goal" },
					},
				],
			});
		});
		await replacement.extension.commands.autonomy?.handler(
			"pause",
			replacement.extension.ctx,
		);
		expect(await replacement.store.load()).toMatchObject({
			id: "replacement-run",
			status: "running",
		});
		expect(replacement.stopCalls()).toBe(1);
		expect(replacement.extension.notifications.at(-1)).toContain(
			"Autonomy run changed",
		);
		expect(replacement.extension.notifications).not.toContain(
			"info:Autonomy paused.",
		);

		const replacementSuccess = await createExternalExtension(
			"external-replacement-success",
			"Fence replacement from success",
			2,
		);
		await replacementSuccess.extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "replacement-success-goal",
					objective: "Fence replacement from success",
					status: "active",
				},
			},
			replacementSuccess.extension.ctx,
		);
		await replacementSuccess.extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "replacement-success-goal",
					objective: "Fence replacement from success",
					status: "complete",
				},
			},
			replacementSuccess.extension.ctx,
		);
		await replacementSuccess.extension.tools.autonomy_gate?.execute(
			"replacement-success-verification",
			{},
			undefined,
			undefined,
			replacementSuccess.extension.ctx,
		);
		replacementSuccess.setStopAction(async () => {
			await replacementSuccess.controller.cancel();
			await new AutonomyController(replacementSuccess.store, {
				createId: () => "replacement-success-run",
			}).start({
				task: "Replacement success run",
				maxAttempts: 2,
				verificationCommand: "bun test",
				ownerSessionFile: join(
					replacementSuccess.cwd,
					"replacement-success.jsonl",
				),
				gates: [
					{
						id: "native-goal",
						label: "OMP native goal",
						requirement: { kind: "native-goal" },
					},
				],
			});
		});
		await expect(
			replacementSuccess.extension.handlers.agent_end?.[0]?.(
				{ messages: [] },
				replacementSuccess.extension.ctx,
			),
		).rejects.toThrow("Autonomy run changed");
		expect(await replacementSuccess.store.load()).toMatchObject({
			id: "replacement-success-run",
			status: "running",
		});
		expect(replacementSuccess.extension.logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);

		const replacementFailure = await createExternalExtension(
			"external-replacement-failure",
			"Fence replacement from failure",
		);
		replacementFailure.setStopAction(async () => {
			await replacementFailure.controller.cancel();
			await new AutonomyController(replacementFailure.store, {
				createId: () => "replacement-failure-run",
			}).start({
				task: "Replacement failure run",
				maxAttempts: 1,
				verificationCommand: "bun test",
				ownerSessionFile: join(
					replacementFailure.cwd,
					"replacement-failure.jsonl",
				),
				gates: [
					{
						id: "native-goal",
						label: "OMP native goal",
						requirement: { kind: "native-goal" },
					},
				],
			});
		});
		await expect(
			replacementFailure.extension.handlers.agent_end?.[0]?.(
				{ messages: [] },
				replacementFailure.extension.ctx,
			),
		).rejects.toThrow("Autonomy run changed");
		expect(await replacementFailure.store.load()).toMatchObject({
			id: "replacement-failure-run",
			status: "running",
		});
		expect(replacementFailure.extension.logs).not.toContain(
			"Autonomy run failed at its maximum attempt bound",
		);

		const success = await createExternalExtension(
			"external-pending-success",
			"External pending success",
			2,
		);
		await success.extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "external-success-goal",
					objective: "External pending success",
					status: "active",
				},
			},
			success.extension.ctx,
		);
		await success.extension.handlers.goal_updated?.[0]?.(
			{
				goal: {
					id: "external-success-goal",
					objective: "External pending success",
					status: "complete",
				},
			},
			success.extension.ctx,
		);
		await success.extension.tools.autonomy_gate?.execute(
			"external-success-verification",
			{},
			undefined,
			undefined,
			success.extension.ctx,
		);
		await success.journal.enqueue(success.workerCommand("success-command"));
		await success.controller.requestTerminalIntent(
			"cancelled",
			"success-command",
		);
		await success.extension.handlers.agent_end?.[0]?.(
			{ messages: [] },
			success.extension.ctx,
		);
		expect(await success.store.load()).toMatchObject({
			status: "running",
			terminalIntent: {
				status: "cancelled",
				commandId: "success-command",
			},
		});
		expect(success.stopCalls()).toBe(0);
		expect(success.extension.logs).not.toContain(
			"Autonomy run succeeded after objective gates passed",
		);

		const failure = await createExternalExtension(
			"external-pending-failure",
			"External pending failure",
		);
		await failure.journal.enqueue(failure.workerCommand("failure-command"));
		const failureClaim = await failure.journal.claimNext(
			"resident-worker",
			5_000,
		);
		if (failureClaim === null) throw new Error("Expected command claim");
		await failure.journal.markUncertain(
			failureClaim.command.id,
			"resident-worker",
			failureClaim.fencingToken,
			"persistence interrupted",
		);
		await failure.controller.requestTerminalIntent("paused", "failure-command");
		await failure.extension.handlers.agent_end?.[0]?.(
			{ messages: [] },
			failure.extension.ctx,
		);
		expect(await failure.store.load()).toMatchObject({
			status: "running",
			terminalIntent: {
				status: "paused",
				commandId: "failure-command",
			},
		});
		expect(failure.stopCalls()).toBe(0);
		expect(failure.extension.logs).not.toContain(
			"Autonomy run failed at its maximum attempt bound",
		);
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
		expect(
			(await loadTestState(ctx.cwd))?.gates.every(
				(gate) => gate.status === "pending",
			),
		).toBe(true);
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
		expect(
			(await loadTestState(ctx.cwd))?.gates.every(
				(gate) => gate.status === "pending",
			),
		).toBe(true);
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
