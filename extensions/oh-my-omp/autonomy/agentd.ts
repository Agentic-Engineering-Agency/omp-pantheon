import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type {
	DaemonOperation,
	DaemonRpcResult,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";

import { AutonomyController } from "./controller";
import { CommandJournal } from "./journal";
import {
	autonomyProjectStateRoot,
	autonomyRuntimeRoot,
	prepareAutonomyRuntimeRoot,
} from "./runtime-paths";
import { PersistedScheduler } from "./scheduler";
import { AutonomyStore } from "./store";
import {
	AutonomyWorker,
	type CommandExecutor,
	OmpSessionExecutor,
} from "./worker";

const DAEMON_NAME_PREFIX = "pantheon-agentd";
const READY_LINE = "pantheon-agentd ready";

export interface BrokerClient {
	request(operation: DaemonOperation): Promise<DaemonRpcResult | unknown>;
	close(): void;
}

interface AgentdOptions {
	broker?: BrokerClient;
	entrypoint?: string;
	executable?: string;
	stateHome?: string;
}

export interface AgentdStatus {
	state: string;
	pid?: number;
	restartCount: number;
}

interface AgentdProcessContext {
	runId?: string;
	command?: {
		runId: string;
		commandId: string;
	};
}

const AGENTD_CONTEXT_KEY = Symbol.for(
	"omp-pantheon.autonomy.agentd-process-context.v1",
);

function sharedAgentdProcessContext(): AgentdProcessContext {
	const scope = globalThis as unknown as { [key: symbol]: unknown };
	const existing = scope[AGENTD_CONTEXT_KEY];
	if (typeof existing === "object" && existing !== null) {
		return existing as AgentdProcessContext;
	}
	const context: AgentdProcessContext = {};
	Object.defineProperty(scope, AGENTD_CONTEXT_KEY, {
		value: context,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	return context;
}

export function updateAgentdProcessContext(
	runId?: string,
	commandId?: string,
): void {
	const context = sharedAgentdProcessContext();
	context.runId = runId;
	context.command =
		runId !== undefined && commandId !== undefined
			? { runId, commandId }
			: undefined;
}

export function isCurrentAgentdRun(runId: string): boolean {
	return sharedAgentdProcessContext().runId === runId;
}

export function currentAgentdCommandId(runId: string): string | undefined {
	const command = sharedAgentdProcessContext().command;
	return command?.runId === runId ? command.commandId : undefined;
}

export async function reconcileResidentTerminal(
	runId: string,
	store: AutonomyStore,
	journal: CommandJournal,
): Promise<boolean> {
	const state = await store.load();
	if (state === null || state.id !== runId) return true;
	if (["paused", "succeeded", "failed", "cancelled"].includes(state.status)) {
		return true;
	}
	const intent = state.terminalIntent;
	if (intent === undefined) return false;
	let record = (await journal.list()).find(
		(candidate) => candidate.command.id === intent.commandId,
	);
	const controller = new AutonomyController(store);
	if (record?.status === "acknowledged") {
		const finalized = await controller.finalizeTerminalIntent(intent.commandId);
		return ["paused", "succeeded", "failed", "cancelled"].includes(
			finalized.status,
		);
	}
	if (record?.status === "claimed" && record.workerId !== undefined) {
		record = await journal.markUncertain(
			record.command.id,
			record.workerId,
			record.fencingToken,
			"Resident worker exited before command acknowledgement",
		);
	}
	await controller.failTerminalIntent(
		intent.commandId,
		record === undefined
			? "Terminal transition command is missing from the journal"
			: `Terminal transition persistence is ${record.status}: ${record.lastError ?? "command was not durably acknowledged"}`,
	);
	return true;
}

export class AutonomyAgentd {
	readonly #brokerPromise: Promise<BrokerClient>;
	readonly #entrypoint: string;
	readonly #executable: string;
	readonly #stateHome?: string;

	constructor(
		private readonly root: string,
		options: AgentdOptions = {},
	) {
		this.#brokerPromise = options.broker
			? Promise.resolve(options.broker)
			: createDaemonBrokerClient(root);
		this.#entrypoint = options.entrypoint ?? import.meta.filename;
		this.#executable = options.executable ?? process.execPath;
		this.#stateHome = options.stateHome;
	}

	async start(runId: string): Promise<AgentdStatus> {
		const broker = await this.#brokerPromise;
		const daemonName = this.#daemonName(runId);
		const stateRoot = autonomyRuntimeRoot(this.root, runId, this.#stateHome);
		const result = await broker.request({
			op: "start",
			owner: daemonName,
			spec: {
				name: daemonName,
				application: this.#executable,
				args: [
					this.#entrypoint,
					"--root",
					this.root,
					"--run-id",
					runId,
					"--state-root",
					stateRoot,
				],
				env:
					this.#stateHome === undefined
						? {}
						: { XDG_STATE_HOME: this.#stateHome },
				cwd: this.root,
				pty: false,
				ready: {
					log: READY_LINE,
					timeoutMs: 10_000,
				},
				restart: "on-failure",
				persist: true,
				detached: false,
			},
		});
		return this.#statusFromResult(result);
	}

	async status(runId: string): Promise<AgentdStatus> {
		const broker = await this.#brokerPromise;
		return this.#statusFromResult(
			await broker.request({ op: "describe", name: this.#daemonName(runId) }),
		);
	}

	async stop(runId: string): Promise<AgentdStatus> {
		const broker = await this.#brokerPromise;
		return this.#statusFromResult(
			await broker.request({
				op: "stop",
				name: this.#daemonName(runId),
				timeoutMs: 5_000,
			}),
		);
	}

	close(): void {
		void this.#brokerPromise.then((broker) => broker.close());
	}

	#daemonName(runId: string): string {
		const suffix = createHash("sha256")
			.update(runId)
			.digest("hex")
			.slice(0, 12);
		return `${DAEMON_NAME_PREFIX}-${suffix}`;
	}

	#statusFromResult(result: unknown): AgentdStatus {
		if (
			typeof result !== "object" ||
			result === null ||
			!("daemon" in result) ||
			typeof result.daemon !== "object" ||
			result.daemon === null ||
			!("state" in result.daemon) ||
			typeof result.daemon.state !== "string"
		) {
			return { state: "starting", restartCount: 0 };
		}
		const daemon = result.daemon as {
			state: string;
			pid?: unknown;
			restartCount?: unknown;
		};
		return {
			state: daemon.state,
			pid: typeof daemon.pid === "number" ? daemon.pid : undefined,
			restartCount:
				typeof daemon.restartCount === "number" ? daemon.restartCount : 0,
		};
	}
}

function parseRequiredArgument(args: string[], name: string): string {
	const index = args.indexOf(name);
	const value = index >= 0 ? args[index + 1] : undefined;
	if (!value) throw new Error(`pantheon-agentd requires ${name} <value>`);
	return value;
}

function scrubAgentdEnvironment(): void {
	const allowed = new Set([
		"HOME",
		"PATH",
		"TMPDIR",
		"TMP",
		"TEMP",
		"USER",
		"SHELL",
		"LANG",
		"LC_ALL",
		"TERM",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
	]);
	for (const name of Object.keys(process.env)) {
		if (!allowed.has(name)) delete process.env[name];
	}
}

async function runAgentd(args: string[]): Promise<void> {
	const root = resolve(parseRequiredArgument(args, "--root"));
	const runId = parseRequiredArgument(args, "--run-id");
	const stateRoot = resolve(parseRequiredArgument(args, "--state-root"));
	const expectedStateRoot = resolve(autonomyRuntimeRoot(root, runId));
	if (stateRoot !== expectedStateRoot) {
		throw new Error(
			"pantheon-agentd state root does not match project and run",
		);
	}
	await prepareAutonomyRuntimeRoot(root, runId);
	scrubAgentdEnvironment();
	const journal = new CommandJournal(stateRoot, {
		expectedRunId: runId,
		expectedCwd: root,
	});
	const store = new AutonomyStore(root, {
		stateDirectory: autonomyProjectStateRoot(root),
	});
	updateAgentdProcessContext(runId);
	const executor = new OmpSessionExecutor();
	const residentExecutor: CommandExecutor = {
		async execute(command, signal) {
			updateAgentdProcessContext(runId, command.id);
			try {
				return await executor.execute(command, signal);
			} finally {
				updateAgentdProcessContext(runId);
			}
		},
		async close() {
			await executor.close();
		},
	};
	const worker = new AutonomyWorker(
		journal,
		residentExecutor,
		{
			workerId: `agentd-${process.pid}-${randomUUID()}`,
			leaseMs: 60_000,
			shouldStop: () => reconcileResidentTerminal(runId, store, journal),
		},
		new PersistedScheduler(stateRoot, journal),
	);
	const shutdown = new AbortController();
	const stop = (): void => shutdown.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	console.log(READY_LINE);
	try {
		await worker.run(shutdown.signal);
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await worker.close();
		updateAgentdProcessContext();
	}
}

if (import.meta.main) {
	await runAgentd(process.argv.slice(2));
}
