import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type {
	DaemonOperation,
	DaemonRpcResult,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";

import { CommandJournal } from "./journal";
import { PersistedScheduler } from "./scheduler";
import { AutonomyWorker, OmpSessionExecutor } from "./worker";

const DAEMON_NAME = "pantheon-agentd";
const READY_LINE = "pantheon-agentd ready";

export interface BrokerClient {
	request(operation: DaemonOperation): Promise<DaemonRpcResult | unknown>;
	close(): void;
}

interface AgentdOptions {
	broker?: BrokerClient;
	entrypoint?: string;
	executable?: string;
}

export interface AgentdStatus {
	state: string;
	pid?: number;
	restartCount: number;
}

export class AutonomyAgentd {
	readonly #brokerPromise: Promise<BrokerClient>;
	readonly #entrypoint: string;
	readonly #executable: string;

	constructor(
		private readonly root: string,
		options: AgentdOptions = {},
	) {
		this.#brokerPromise = options.broker
			? Promise.resolve(options.broker)
			: createDaemonBrokerClient(root);
		this.#entrypoint = options.entrypoint ?? import.meta.filename;
		this.#executable = options.executable ?? process.execPath;
	}

	async start(): Promise<AgentdStatus> {
		const broker = await this.#brokerPromise;
		const result = await broker.request({
			op: "start",
			owner: DAEMON_NAME,
			spec: {
				name: DAEMON_NAME,
				application: this.#executable,
				args: [this.#entrypoint, "--root", this.root],
				env: {},
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

	async status(): Promise<AgentdStatus> {
		const broker = await this.#brokerPromise;
		return this.#statusFromResult(
			await broker.request({ op: "describe", name: DAEMON_NAME }),
		);
	}

	async stop(): Promise<AgentdStatus> {
		const broker = await this.#brokerPromise;
		return this.#statusFromResult(
			await broker.request({
				op: "stop",
				name: DAEMON_NAME,
				timeoutMs: 5_000,
			}),
		);
	}

	close(): void {
		void this.#brokerPromise.then((broker) => broker.close());
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

function parseRoot(args: string[]): string {
	const rootIndex = args.indexOf("--root");
	const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
	if (!root) throw new Error("pantheon-agentd requires --root <project>");
	return resolve(root);
}

async function runAgentd(args: string[]): Promise<void> {
	const root = parseRoot(args);
	const journal = new CommandJournal(root);
	const worker = new AutonomyWorker(
		journal,
		new OmpSessionExecutor(),
		{
			workerId: `agentd-${process.pid}-${randomUUID()}`,
			leaseMs: 60_000,
		},
		new PersistedScheduler(root, journal),
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
	}
}

if (import.meta.main) {
	await runAgentd(process.argv.slice(2));
}
