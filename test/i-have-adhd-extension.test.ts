import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import registerIHaveAdhd from "../extensions/i-have-adhd/index.ts";

const extensionEntry = join(
	import.meta.dir,
	"..",
	"extensions",
	"i-have-adhd",
	"index.ts",
);
const RULES_MESSAGE_TYPE = "i-have-adhd-rules";
const DISABLED_MESSAGE_TYPE = "i-have-adhd-disabled";
const STATE_ENTRY_TYPE = "i-have-adhd-state";

type SessionEntry =
	| { type: "compaction" }
	| { type: "custom"; customType: string; data: unknown }
	| {
			type: "custom_message";
			customType: string;
			content: string;
			display: boolean;
	  };

interface FakeContext {
	hasUI: boolean;
	sessionManager: {
		getBranch: () => SessionEntry[];
	};
	ui: {
		notify: (message: string, level: string) => void;
		setStatus: (key: string, status: string | undefined) => void;
	};
}

interface RegisteredCommand {
	handler: (args: string, ctx: FakeContext) => Promise<void>;
}

type EventHandler = (
	event: unknown,
	ctx: FakeContext,
) => Promise<unknown> | unknown;

interface FakeExtension {
	readonly branch: SessionEntry[];
	commands: Record<string, RegisteredCommand>;
	ctx: FakeContext;
	handlers: Record<string, EventHandler>;
	messages: SessionEntry[];
	notifications: string[];
	setBranch: (nextBranch: SessionEntry[]) => void;
	statuses: Array<string | undefined>;
}

interface FakeExtensionOptions {
	adhd?: boolean;
	branch?: SessionEntry[];
	hasUI?: boolean;
}

function createFakeExtension(
	options: FakeExtensionOptions = {},
): FakeExtension {
	let branch = options.branch ?? [];
	const commands: Record<string, RegisteredCommand> = {};
	const handlers: Record<string, EventHandler> = {};
	const flags: Record<string, boolean> = { adhd: options.adhd ?? false };
	const messages: SessionEntry[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		getFlag(name: string) {
			return flags[name];
		},
		on(event: string, handler: EventHandler) {
			handlers[event] = handler;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands[name] = command;
		},
		registerFlag() {},
		sendMessage(message: {
			content: string;
			customType: string;
			display: boolean;
		}) {
			const entry = { type: "custom_message" as const, ...message };
			branch.push(entry);
			messages.push(entry);
		},
	};
	const ctx: FakeContext = {
		hasUI: options.hasUI ?? true,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify(message, level) {
				notifications.push(`${level}:${message}`);
			},
			setStatus(_key, status) {
				statuses.push(status);
			},
		},
	};

	registerIHaveAdhd(pi as never);

	return {
		get branch() {
			return branch;
		},
		commands,
		ctx,
		handlers,
		messages,
		notifications,
		setBranch(nextBranch) {
			branch = nextBranch;
		},
		statuses,
	};
}

async function dispatch(
	fixture: FakeExtension,
	event: string,
	payload: unknown = {},
): Promise<unknown> {
	const handler = fixture.handlers[event];
	if (!handler) throw new Error(`Missing ${event} handler`);
	return handler(payload, fixture.ctx);
}

test("ships an OMP ADHD extension entry point", () => {
	expect(existsSync(extensionEntry)).toBe(true);
});

test("enables with --adhd and injects the hidden ruleset", async () => {
	const fixture = createFakeExtension({ adhd: true });

	await dispatch(fixture, "session_start");

	expect(fixture.statuses).toEqual(["● ADHD ON"]);
	expect(fixture.messages).toHaveLength(1);
	expect(fixture.messages[0]).toMatchObject({
		customType: RULES_MESSAGE_TYPE,
		display: false,
	});
	expect(fixture.branch[0]).toMatchObject({
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: { enabled: true },
	});
});

test("restores a saved enabled state before applying default flags", async () => {
	const fixture = createFakeExtension({
		branch: [
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { enabled: true },
			},
		],
	});

	await dispatch(fixture, "session_start");

	expect(fixture.statuses).toEqual(["● ADHD ON"]);
	expect(fixture.messages[0]).toMatchObject({ customType: RULES_MESSAGE_TYPE });
});

test("restores mode state on session switch and branch boundaries", async () => {
	const fixture = createFakeExtension();

	await dispatch(fixture, "input", { text: "/skill:i-have-adhd" });
	fixture.setBranch([]);
	await dispatch(fixture, "session_switch");
	await dispatch(fixture, "session_compact");

	expect(fixture.statuses.at(-1)).toBeUndefined();
	expect(fixture.messages).toHaveLength(1);

	fixture.setBranch([
		{
			type: "custom",
			customType: STATE_ENTRY_TYPE,
			data: { enabled: true },
		},
	]);
	await dispatch(fixture, "session_branch");

	expect(fixture.statuses.at(-1)).toBe("● ADHD ON");
	expect(await dispatch(fixture, "input", { text: "normal mode" })).toEqual({
		handled: true,
	});
});

test("enables from the agent-local sentinel", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "i-have-adhd-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(join(agentDir, ".i-have-adhd-always"), "");

	try {
		const fixture = createFakeExtension();
		await dispatch(fixture, "session_start");
		expect(fixture.statuses).toEqual(["● ADHD ON"]);
	} finally {
		if (previousAgentDir === undefined) {
			process.env.PI_CODING_AGENT_DIR = undefined;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("persists a disabled command state and neutralizes injected rules", async () => {
	const fixture = createFakeExtension({ adhd: true });

	await dispatch(fixture, "session_start");
	await fixture.commands["i-have-adhd"]?.handler("off", fixture.ctx);

	expect(fixture.branch.at(-2)).toMatchObject({
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: { enabled: false },
	});
	expect(fixture.messages.at(-1)).toMatchObject({
		customType: DISABLED_MESSAGE_TYPE,
		display: false,
	});
	expect(fixture.statuses.at(-1)).toBeUndefined();
	expect(fixture.notifications.at(-1)).toBe("info:ADHD mode disabled");
});

test("reinjects enabled rules after compaction", async () => {
	const fixture = createFakeExtension({ adhd: true });

	await dispatch(fixture, "session_start");
	fixture.branch.push({ type: "compaction" });
	await dispatch(fixture, "session_compact");

	expect(
		fixture.messages.filter(
			(message) =>
				message.type === "custom_message" &&
				message.customType === RULES_MESSAGE_TYPE,
		),
	).toHaveLength(2);
});

test("supports the upstream alias and stop phrase without reaching the model", async () => {
	const fixture = createFakeExtension();

	expect(
		await dispatch(fixture, "input", { text: "/skill:i-have-adhd" }),
	).toEqual({ handled: true });
	expect(fixture.statuses.at(-1)).toBe("● ADHD ON");
	expect(await dispatch(fixture, "input", { text: "normal mode" })).toEqual({
		handled: true,
	});
	expect(fixture.statuses.at(-1)).toBeUndefined();
});

test("replaces headless stop phrases and drops pending images", async () => {
	const fixture = createFakeExtension({ adhd: true, hasUI: false });

	await dispatch(fixture, "session_start");

	expect(
		await dispatch(fixture, "input", {
			text: "stop adhd mode",
			images: [{ type: "image", data: "sensitive" }],
		}),
	).toEqual({
		text: "Reply with exactly: ADHD mode disabled.",
		images: [],
	});
});
