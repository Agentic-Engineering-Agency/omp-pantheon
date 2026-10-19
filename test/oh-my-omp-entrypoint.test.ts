import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import registerPantheon from "../extensions/oh-my-omp/index";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

async function loadEntrypoint() {
	const handlers: Record<string, EventHandler[]> = {};
	const commands: string[] = [];
	const tools: string[] = [];
	const logger = { debug() {}, info() {}, warn() {} };
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		logger,
	};
	await registerPantheon(pi as never);
	return { commands, handlers, tools };
}

describe("oh-my-omp entrypoint", () => {
	test("exposes bundled skills and registers no commands or tools", async () => {
		const { commands, handlers, tools } = await loadEntrypoint();
		const resources = (await handlers.resources_discover?.[0]?.({}, {})) as {
			skillPaths: string[];
		};

		expect(commands).toEqual([]);
		expect(tools).toEqual([]);
		expect(resources.skillPaths).toEqual([join(import.meta.dir, "../skills")]);
		expect(handlers.before_agent_start).toHaveLength(3);
	});
});
