import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { acquireFileLock } from "../file-lock";
import { appendPrivateFile, ensurePrivateDirectory } from "../private-files";

const JOURNAL_FILE = "commands.jsonl";
const LOCK_FILE = "commands.lock";

export interface WorkerCommand {
	schemaVersion: 1;
	id: string;
	runId: string;
	cwd: string;
	sessionFile: string;
	prompt: string;
	maxAttempts: number;
	createdAt: string;
}

export interface CommandPersistenceReceipt {
	sessionId: string;
	sessionFile?: string;
	persistedAt: string;
}

export type CommandStatus =
	| "queued"
	| "claimed"
	| "acknowledged"
	| "failed"
	| "uncertain";

export interface CommandRecord {
	command: WorkerCommand;
	status: CommandStatus;
	fencingToken: number;
	attempts: number;
	workerId?: string;
	leaseUntil?: string;
	acknowledgedAt?: string;
	lastError?: string;
	failedAt?: string;
	uncertainAt?: string;
	receipt?: CommandPersistenceReceipt;
}

type CommandEventType =
	| "enqueued"
	| "claimed"
	| "renewed"
	| "acknowledged"
	| "released"
	| "failed"
	| "uncertain";

interface CommandJournalEvent {
	schemaVersion: 1;
	sequence: number;
	at: string;
	type: CommandEventType;
	commandId: string;
	command?: WorkerCommand;
	workerId?: string;
	leaseUntil?: string;
	fencingToken?: number;
	error?: string;
	receipt?: CommandPersistenceReceipt;
	checksum: string;
}

interface CommandJournalOptions {
	now?: () => number;
	expectedRunId?: string;
	expectedCwd?: string;
}

export class CommandJournalError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CommandJournalError";
	}
}

export class CommandJournal {
	readonly path: string;
	readonly #lockPath: string;
	readonly #now: () => number;
	readonly #expectedRunId?: string;
	readonly #expectedCwd?: string;

	constructor(root: string, options: CommandJournalOptions = {}) {
		this.path = join(root, JOURNAL_FILE);
		this.#lockPath = join(root, LOCK_FILE);
		this.#now = options.now ?? Date.now;
		this.#expectedRunId = options.expectedRunId;
		this.#expectedCwd =
			options.expectedCwd === undefined
				? undefined
				: resolve(options.expectedCwd);
	}

	async enqueue(command: WorkerCommand): Promise<CommandRecord> {
		this.#assertCommand(command);
		return this.#mutate(async (records, sequence) => {
			const existing = records.get(command.id);
			if (existing) {
				if (JSON.stringify(existing.command) !== JSON.stringify(command)) {
					throw new CommandJournalError(
						`Command ${command.id} already exists with a different payload`,
					);
				}
				return existing;
			}
			await this.#append({
				sequence,
				at: this.#isoNow(),
				type: "enqueued",
				commandId: command.id,
				command,
			});
			return {
				command,
				status: "queued",
				fencingToken: 0,
				attempts: 0,
			};
		});
	}

	async claimNext(
		workerId: string,
		leaseMs: number,
	): Promise<CommandRecord | null> {
		if (workerId.trim().length === 0) {
			throw new CommandJournalError("Worker ID must not be empty");
		}
		if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
			throw new CommandJournalError(
				"Lease duration must be a positive integer",
			);
		}
		return this.#mutate(async (records, sequence) => {
			const now = this.#now();
			const candidate = [...records.values()]
				.filter(
					(record) =>
						record.status === "queued" ||
						(record.status === "claimed" &&
							record.leaseUntil !== undefined &&
							Date.parse(record.leaseUntil) <= now),
				)
				.sort((left, right) =>
					left.command.createdAt.localeCompare(right.command.createdAt),
				)[0];
			if (!candidate) return null;
			const fencingToken = candidate.fencingToken + 1;
			const leaseUntil = new Date(now + leaseMs).toISOString();
			await this.#append({
				sequence,
				at: this.#isoNow(),
				type: "claimed",
				commandId: candidate.command.id,
				workerId,
				leaseUntil,
				fencingToken,
			});
			return {
				...candidate,
				status: "claimed",
				workerId,
				leaseUntil,
				fencingToken,
				attempts: candidate.attempts + 1,
				lastError: undefined,
			};
		});
	}

	async renewLease(
		commandId: string,
		workerId: string,
		fencingToken: number,
		leaseMs: number,
	): Promise<CommandRecord> {
		if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
			throw new CommandJournalError(
				"Lease duration must be a positive integer",
			);
		}
		return this.#mutate(async (records, sequence) => {
			const record = this.#requireActiveClaim(
				records,
				commandId,
				workerId,
				fencingToken,
			);
			const leaseUntil = new Date(this.#now() + leaseMs).toISOString();
			await this.#append({
				sequence,
				at: this.#isoNow(),
				type: "renewed",
				commandId,
				workerId,
				fencingToken,
				leaseUntil,
			});
			return { ...record, leaseUntil };
		});
	}

	async acknowledge(
		commandId: string,
		workerId: string,
		fencingToken: number,
		receipt: CommandPersistenceReceipt,
	): Promise<CommandRecord> {
		this.#assertReceipt(receipt);
		return this.#mutate(async (records, sequence) => {
			const record = this.#requireActiveClaim(
				records,
				commandId,
				workerId,
				fencingToken,
			);
			const acknowledgedAt = this.#isoNow();
			await this.#append({
				sequence,
				at: acknowledgedAt,
				type: "acknowledged",
				commandId,
				workerId,
				fencingToken,
				receipt,
			});
			return {
				...record,
				status: "acknowledged",
				acknowledgedAt,
				receipt,
				leaseUntil: undefined,
			};
		});
	}

	async release(
		commandId: string,
		workerId: string,
		fencingToken: number,
		error: string,
	): Promise<CommandRecord> {
		if (error.trim().length === 0) {
			throw new CommandJournalError(
				"Command failure evidence must not be empty",
			);
		}
		return this.#mutate(async (records, sequence) => {
			const record = this.#requireClaim(
				records,
				commandId,
				workerId,
				fencingToken,
			);
			const failed = record.attempts >= record.command.maxAttempts;
			const at = this.#isoNow();
			await this.#append({
				sequence,
				at,
				type: failed ? "failed" : "released",
				commandId,
				workerId,
				fencingToken,
				error: error.trim(),
			});
			return {
				...record,
				status: failed ? "failed" : "queued",
				workerId: undefined,
				leaseUntil: undefined,
				lastError: error.trim(),
				failedAt: failed ? at : undefined,
			};
		});
	}

	async markUncertain(
		commandId: string,
		workerId: string,
		fencingToken: number,
		error: string,
	): Promise<CommandRecord> {
		if (error.trim().length === 0) {
			throw new CommandJournalError(
				"Uncertain outcome evidence must not be empty",
			);
		}
		return this.#mutate(async (records, sequence) => {
			const record = this.#requireClaim(
				records,
				commandId,
				workerId,
				fencingToken,
			);
			const uncertainAt = this.#isoNow();
			await this.#append({
				sequence,
				at: uncertainAt,
				type: "uncertain",
				commandId,
				workerId,
				fencingToken,
				error: error.trim(),
			});
			return {
				...record,
				status: "uncertain",
				workerId: undefined,
				leaseUntil: undefined,
				lastError: error.trim(),
				uncertainAt,
			};
		});
	}

	async list(): Promise<CommandRecord[]> {
		return [...(await this.#load()).values()];
	}

	async #mutate<T>(
		operation: (
			records: Map<string, CommandRecord>,
			sequence: number,
		) => Promise<T>,
	): Promise<T> {
		const releaseLock = await this.#acquireLock();
		try {
			const records = await this.#load();
			return await operation(records, await this.#nextSequence());
		} finally {
			await releaseLock();
		}
	}

	async #load(): Promise<Map<string, CommandRecord>> {
		const raw = await this.#readOptional(this.path);
		const records = new Map<string, CommandRecord>();
		if (raw === null) return records;
		const lines = raw.split("\n").filter((line) => line.length > 0);
		for (const [index, line] of lines.entries()) {
			const event = this.#parseEvent(line, index + 1);
			this.#apply(records, event);
		}
		return records;
	}

	async #nextSequence(): Promise<number> {
		const raw = await this.#readOptional(this.path);
		if (raw === null || raw.length === 0) return 1;
		return raw.split("\n").filter((line) => line.length > 0).length + 1;
	}

	#apply(
		records: Map<string, CommandRecord>,
		event: CommandJournalEvent,
	): void {
		if (event.type === "enqueued") {
			if (!event.command || records.has(event.commandId)) {
				throw new CommandJournalError(
					`Invalid enqueue event for command ${event.commandId}`,
				);
			}
			this.#assertCommand(event.command);
			records.set(event.commandId, {
				command: event.command,
				status: "queued",
				fencingToken: 0,
				attempts: 0,
			});
			return;
		}
		const record = records.get(event.commandId);
		if (!record) {
			throw new CommandJournalError(
				`Command event references missing command ${event.commandId}`,
			);
		}
		if (event.type === "claimed") {
			if (
				!event.workerId ||
				!event.leaseUntil ||
				event.fencingToken !== record.fencingToken + 1 ||
				(record.status !== "queued" && record.status !== "claimed")
			) {
				throw new CommandJournalError(
					`Invalid claim event for command ${event.commandId}`,
				);
			}
			Object.assign(record, {
				status: "claimed",
				workerId: event.workerId,
				leaseUntil: event.leaseUntil,
				fencingToken: event.fencingToken,
				attempts: record.attempts + 1,
				lastError: undefined,
			});
			return;
		}
		this.#assertEventClaim(record, event);
		if (event.type === "renewed") {
			if (!event.leaseUntil) {
				throw new CommandJournalError(
					`Lease renewal for command ${event.commandId} lacks a deadline`,
				);
			}
			record.leaseUntil = event.leaseUntil;
			return;
		}
		if (event.type === "released" || event.type === "failed") {
			Object.assign(record, {
				status: event.type === "failed" ? "failed" : "queued",
				workerId: undefined,
				leaseUntil: undefined,
				lastError: event.error,
				failedAt: event.type === "failed" ? event.at : undefined,
			});
			return;
		}
		if (event.type === "uncertain") {
			Object.assign(record, {
				status: "uncertain",
				workerId: undefined,
				leaseUntil: undefined,
				lastError: event.error,
				uncertainAt: event.at,
			});
			return;
		}
		if (!event.receipt) {
			throw new CommandJournalError(
				`Acknowledgement for command ${event.commandId} lacks a receipt`,
			);
		}
		this.#assertReceipt(event.receipt);
		Object.assign(record, {
			status: "acknowledged",
			workerId: undefined,
			leaseUntil: undefined,
			acknowledgedAt: event.at,
			receipt: event.receipt,
		});
	}

	#assertEventClaim(record: CommandRecord, event: CommandJournalEvent): void {
		if (
			record.status !== "claimed" ||
			event.workerId !== record.workerId ||
			event.fencingToken !== record.fencingToken
		) {
			throw new CommandJournalError(
				`Stale fencing token for command ${event.commandId}`,
			);
		}
	}

	#requireClaim(
		records: Map<string, CommandRecord>,
		commandId: string,
		workerId: string,
		fencingToken: number,
	): CommandRecord {
		const record = records.get(commandId);
		if (
			!record ||
			record.status !== "claimed" ||
			record.workerId !== workerId ||
			record.fencingToken !== fencingToken
		) {
			throw new CommandJournalError(
				`Worker ${workerId} holds a stale fencing token for command ${commandId}`,
			);
		}
		return record;
	}

	#requireActiveClaim(
		records: Map<string, CommandRecord>,
		commandId: string,
		workerId: string,
		fencingToken: number,
	): CommandRecord {
		const record = this.#requireClaim(
			records,
			commandId,
			workerId,
			fencingToken,
		);
		if (!record.leaseUntil || Date.parse(record.leaseUntil) <= this.#now()) {
			throw new CommandJournalError(`Lease expired for command ${commandId}`);
		}
		return record;
	}

	async #append(
		event: Omit<CommandJournalEvent, "schemaVersion" | "checksum">,
	): Promise<void> {
		const withoutChecksum = { schemaVersion: 1 as const, ...event };
		const checksum = createHash("sha256")
			.update(JSON.stringify(withoutChecksum))
			.digest("hex");
		await appendPrivateFile(
			this.path,
			`${JSON.stringify({ ...withoutChecksum, checksum })}\n`,
		);
	}

	#parseEvent(raw: string, expectedSequence: number): CommandJournalEvent {
		let event: CommandJournalEvent;
		try {
			event = JSON.parse(raw) as CommandJournalEvent;
		} catch (error) {
			throw new CommandJournalError(
				`Command journal line ${expectedSequence} is invalid JSON`,
				{ cause: error },
			);
		}
		if (event.schemaVersion !== 1 || event.sequence !== expectedSequence) {
			throw new CommandJournalError(
				`Command journal sequence is non-contiguous at ${expectedSequence}`,
			);
		}
		const { checksum, ...withoutChecksum } = event;
		const expectedChecksum = createHash("sha256")
			.update(JSON.stringify(withoutChecksum))
			.digest("hex");
		if (checksum !== expectedChecksum) {
			throw new CommandJournalError(
				`Command journal checksum mismatch at ${expectedSequence}`,
			);
		}
		return event;
	}

	#assertCommand(command: WorkerCommand): void {
		if (
			command.schemaVersion !== 1 ||
			command.id.trim().length === 0 ||
			command.runId.trim().length === 0 ||
			!isAbsolute(command.cwd) ||
			!isAbsolute(command.sessionFile) ||
			command.prompt.trim().length === 0 ||
			!Number.isInteger(command.maxAttempts) ||
			command.maxAttempts <= 0 ||
			!Number.isFinite(Date.parse(command.createdAt)) ||
			(this.#expectedRunId !== undefined &&
				command.runId !== this.#expectedRunId) ||
			(this.#expectedCwd !== undefined &&
				resolve(command.cwd) !== this.#expectedCwd)
		) {
			throw new CommandJournalError("Worker command has an invalid shape");
		}
	}

	#assertReceipt(receipt: CommandPersistenceReceipt): void {
		if (
			receipt.sessionId.trim().length === 0 ||
			!Number.isFinite(Date.parse(receipt.persistedAt))
		) {
			throw new CommandJournalError("Invalid command persistence receipt");
		}
	}

	#isoNow(): string {
		return new Date(this.#now()).toISOString();
	}

	async #readOptional(path: string): Promise<string | null> {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async #acquireLock(): Promise<() => Promise<void>> {
		await ensurePrivateDirectory(dirname(this.#lockPath));
		return acquireFileLock(this.#lockPath);
	}
}
