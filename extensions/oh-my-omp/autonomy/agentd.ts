import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type {
	DaemonOperation,
	DaemonRpcResult,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";

import { CommandJournal } from "./journal";
import {
	autonomyProjectStateRoot,
	autonomyRuntimeRoot,
	prepareAutonomyRuntimeRoot,
} from "./runtime-paths";
import { PersistedScheduler } from "./scheduler";
import { AutonomyStore } from "./store";
import { AutonomyWorker, OmpSessionExecutor } from "./worker";

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

let currentAgentdRunId: string | undefined;

export function isCurrentAgentdRun(runId: string): boolean {
	return currentAgentdRunId === runId;
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
	currentAgentdRunId = runId;
	const worker = new AutonomyWorker(
		journal,
		new OmpSessionExecutor(),
		{
			workerId: `agentd-${process.pid}-${randomUUID()}`,
			leaseMs: 60_000,
			shouldStop: async () => {
				const state = await store.load();
				return (
					state?.id === runId &&
					["paused", "succeeded", "failed", "cancelled"].includes(state.status)
				);
			},
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
		currentAgentdRunId = undefined;
	}
}

if (import.meta.main) {
	await runAgentd(process.argv.slice(2));
}
