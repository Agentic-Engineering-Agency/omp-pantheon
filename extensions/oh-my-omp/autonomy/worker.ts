import { SessionManager, createAgentSession } from "@oh-my-pi/pi-coding-agent";

import type {
	CommandJournal,
	CommandPersistenceReceipt,
	WorkerCommand,
} from "./journal";
import type { PersistedScheduler } from "./scheduler";

export interface CommandExecutor {
	execute(
		command: WorkerCommand,
		signal: AbortSignal,
	): Promise<CommandPersistenceReceipt>;
	close(): Promise<void>;
}

interface SessionManagerHandle {
	native?: unknown;
	sessionFile: string;
}

interface HeadlessSession {
	sessionId: string;
	sessionFile?: string;
	prompt(prompt: string): Promise<unknown>;
	waitForIdle(): Promise<void>;
	flush(): Promise<void>;
	dispose(): Promise<void>;
}

interface OmpSessionAdapter {
	openSessionManager(sessionFile: string): Promise<SessionManagerHandle>;
	createSession(options: {
		cwd: string;
		sessionManager: SessionManagerHandle;
	}): Promise<HeadlessSession>;
	now?: () => string;
}

const defaultSessionAdapter: OmpSessionAdapter = {
	async openSessionManager(sessionFile) {
		return {
			native: await SessionManager.open(sessionFile),
			sessionFile,
		};
	},
	async createSession({ cwd, sessionManager }) {
		const nativeManager = sessionManager.native;
		if (!(nativeManager instanceof SessionManager)) {
			throw new Error(
				"OMP session manager adapter returned an invalid manager",
			);
		}
		const { session } = await createAgentSession({
			cwd,
			hasUI: false,
			sessionManager: nativeManager,
		});
		return {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			prompt: (prompt) =>
				session.prompt(prompt, { expandPromptTemplates: false }),
			waitForIdle: () => session.waitForIdle(),
			flush: () => session.sessionManager.flush(),
			dispose: () => session.dispose(),
		};
	},
};

export class OmpSessionExecutor implements CommandExecutor {
	readonly #adapter: OmpSessionAdapter;
	readonly #activeSessions = new Set<HeadlessSession>();
	#closed = false;

	constructor(adapter: OmpSessionAdapter = defaultSessionAdapter) {
		this.#adapter = adapter;
	}

	async execute(
		command: WorkerCommand,
		signal: AbortSignal,
	): Promise<CommandPersistenceReceipt> {
		if (this.#closed) throw new Error("OMP session executor is closed");
		if (signal.aborted) throw new Error("OMP session execution aborted");
		const sessionManager = await this.#adapter.openSessionManager(
			command.sessionFile,
		);
		const session = await this.#adapter.createSession({
			cwd: command.cwd,
			sessionManager,
		});
		this.#activeSessions.add(session);
		const abort = (): void => {
			void session.dispose();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			await session.prompt(command.prompt);
			await session.waitForIdle();
			await session.flush();
			return {
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				persistedAt: this.#adapter.now?.() ?? new Date().toISOString(),
			};
		} finally {
			signal.removeEventListener("abort", abort);
			this.#activeSessions.delete(session);
			await session.dispose();
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.allSettled(
			[...this.#activeSessions].map((session) => session.dispose()),
		);
		this.#activeSessions.clear();
	}
}

interface AutonomyWorkerOptions {
	workerId: string;
	leaseMs: number;
	pollMs?: number;
	shouldStop?: () => Promise<boolean>;
}

export class AutonomyWorker {
	readonly #pollMs: number;
	#activeExecution: AbortController | null = null;
	#closed = false;

	constructor(
		private readonly journal: CommandJournal,
		private readonly executor: CommandExecutor,
		private readonly options: AutonomyWorkerOptions,
		private readonly scheduler?: PersistedScheduler,
	) {
		this.#pollMs = options.pollMs ?? 250;
		if (options.workerId.trim().length === 0) {
			throw new Error("Worker ID must not be empty");
		}
		if (!Number.isInteger(options.leaseMs) || options.leaseMs <= 0) {
			throw new Error("Worker lease must be a positive integer");
		}
	}

	async runOnce(): Promise<boolean> {
		if (this.#closed) return false;
		await this.scheduler?.deliverDue(
			this.options.workerId,
			this.options.leaseMs,
		);
		const claimed = await this.journal.claimNext(
			this.options.workerId,
			this.options.leaseMs,
		);
		if (!claimed) return false;
		const controller = new AbortController();
		this.#activeExecution = controller;
		let heartbeatFailure: unknown;
		let renewing = Promise.resolve();
		const heartbeat = setInterval(
			() => {
				renewing = renewing
					.then(() =>
						this.journal.renewLease(
							claimed.command.id,
							this.options.workerId,
							claimed.fencingToken,
							this.options.leaseMs,
						),
					)
					.then(() => undefined)
					.catch((error: unknown) => {
						heartbeatFailure = error;
						controller.abort();
					});
			},
			Math.max(10, Math.floor(this.options.leaseMs / 3)),
		);
		try {
			let receipt: CommandPersistenceReceipt;
			try {
				receipt = await this.executor.execute(
					claimed.command,
					controller.signal,
				);
			} catch (error) {
				await renewing;
				const failure = heartbeatFailure ?? error;
				await this.journal.release(
					claimed.command.id,
					this.options.workerId,
					claimed.fencingToken,
					failure instanceof Error ? failure.message : String(failure),
				);
				throw failure;
			}
			await renewing;
			const receiptError =
				heartbeatFailure ??
				(receipt.sessionId.trim().length === 0 ||
				!Number.isFinite(Date.parse(receipt.persistedAt))
					? new Error("Executor returned an invalid persistence receipt")
					: undefined);
			if (receiptError !== undefined) {
				const message =
					receiptError instanceof Error
						? receiptError.message
						: String(receiptError);
				await this.journal.markUncertain(
					claimed.command.id,
					this.options.workerId,
					claimed.fencingToken,
					message,
				);
				throw receiptError;
			}
			try {
				await this.journal.acknowledge(
					claimed.command.id,
					this.options.workerId,
					claimed.fencingToken,
					receipt,
				);
			} catch (error) {
				await this.journal.markUncertain(
					claimed.command.id,
					this.options.workerId,
					claimed.fencingToken,
					`Execution completed but acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				throw error;
			}
			return true;
		} finally {
			clearInterval(heartbeat);
			await renewing;
			if (this.#activeExecution === controller) {
				this.#activeExecution = null;
			}
		}
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted && !this.#closed) {
			if (await this.options.shouldStop?.()) break;
			try {
				const executed = await this.runOnce();
				if (await this.options.shouldStop?.()) break;
				if (executed) continue;
			} catch (error) {
				if (signal.aborted || this.#closed) break;
				console.error(
					`pantheon-agentd command failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			await Bun.sleep(this.#pollMs);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#activeExecution?.abort();
		await this.executor.close();
	}
}
