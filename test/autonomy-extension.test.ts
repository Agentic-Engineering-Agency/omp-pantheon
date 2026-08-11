import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { registerAutonomy } from "../extensions/oh-my-omp/autonomy/runtime";
import registerPantheon from "../extensions/oh-my-omp/index";

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
	ui: {
		notify: (message: string, level: string) => void;
	};
}

type EventHandler = (event: never, ctx: FakeContext) => Promise<void> | void;

const roots: string[] = [];
const registerTestAutonomy = (pi: never): unknown =>
	registerAutonomy(pi, {
		async verify(_cwd, command) {
			return {
				status: "pass",
				evidence: `command:${command}:exit:0`,
			};
		},
	});

async function createFakeExtension(
	register: (pi: never) => unknown | Promise<unknown> = registerTestAutonomy,
) {
	const cwd = await mkdtemp(join(tmpdir(), "pantheon-autonomy-extension-"));
	roots.push(cwd);
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
});
