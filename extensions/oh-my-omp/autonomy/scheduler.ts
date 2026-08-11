import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock } from "../file-lock";

import type { CommandJournal, WorkerCommand } from "./journal";

const SCHEDULER_DIRECTORY = "scheduler";
const MANIFEST_FILE = "manifest.json";
const GENERATIONS_DIRECTORY = "generations";
const SNAPSHOT_FILE = "snapshot.json";
const EVENTS_FILE = "events.jsonl";
const LOCK_FILE = "scheduler.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

export interface ScheduleRequest {
	schemaVersion: 1;
	id: string;
	coalesceKey: string;
	command: WorkerCommand;
	deadline: string;
}

export type ScheduleStatus = "scheduled" | "claimed" | "delivered" | "failed";

export interface ScheduleRecord {
	request: ScheduleRequest;
	status: ScheduleStatus;
	retryCount: number;
	nextDeadline: string;
	fencingToken: number;
	workerId?: string;
	leaseUntil?: string;
	lastError?: string;
	deliveredAt?: string;
	failedAt?: string;
}

type ScheduleEventType =
	| "scheduled"
	| "claimed"
	| "delivered"
	| "retry_scheduled"
	| "failed";

interface ScheduleEvent {
	schemaVersion: 1;
	sequence: number;
	at: string;
	type: ScheduleEventType;
	scheduleId: string;
	request?: ScheduleRequest;
	workerId?: string;
	leaseUntil?: string;
	fencingToken?: number;
	retryCount?: number;
	nextDeadline?: string;
	error?: string;
	checksum: string;
}

interface SchedulerSnapshot {
	schemaVersion: 1;
	sequence: number;
	records: ScheduleRecord[];
	checksum: string;
}

interface SchedulerManifest {
	schemaVersion: 1;
	activeGeneration: number;
	previousGeneration?: number;
}

interface SchedulerState {
	manifest: SchedulerManifest;
	records: Map<string, ScheduleRecord>;
	sequence: number;
}

interface SchedulerOptions {
	now?: () => number;
	maxRetries?: number;
	baseRetryMs?: number;
	lockTimeoutMs?: number;
	lockStaleMs?: number;
}

export class SchedulerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SchedulerError";
	}
}

export class PersistedScheduler {
	readonly #directory: string;
	readonly #manifestPath: string;
	readonly #generationsPath: string;
	readonly #lockPath: string;
	readonly #now: () => number;
	readonly #maxRetries: number;
	readonly #baseRetryMs: number;
	readonly #lockTimeoutMs: number;
	readonly #lockStaleMs: number;

	constructor(
		root: string,
		private readonly commandJournal: CommandJournal,
		options: SchedulerOptions = {},
	) {
		this.#directory = join(root, SCHEDULER_DIRECTORY);
		this.#manifestPath = join(this.#directory, MANIFEST_FILE);
		this.#generationsPath = join(this.#directory, GENERATIONS_DIRECTORY);
		this.#lockPath = join(this.#directory, LOCK_FILE);
		this.#now = options.now ?? Date.now;
		this.#maxRetries = options.maxRetries ?? 5;
		this.#baseRetryMs = options.baseRetryMs ?? 1_000;
		this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
		this.#lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
		if (!Number.isInteger(this.#maxRetries) || this.#maxRetries <= 0) {
			throw new SchedulerError("Maximum retries must be a positive integer");
		}
		if (!Number.isInteger(this.#baseRetryMs) || this.#baseRetryMs <= 0) {
			throw new SchedulerError("Base retry delay must be a positive integer");
		}
		if (
			!Number.isInteger(this.#lockTimeoutMs) ||
			this.#lockTimeoutMs <= 0 ||
			!Number.isInteger(this.#lockStaleMs) ||
			this.#lockStaleMs <= 0
		) {
			throw new SchedulerError(
				"Scheduler lock timeout and stale age must be positive integers",
			);
		}
	}

	async schedule(request: ScheduleRequest): Promise<ScheduleRecord> {
		this.#assertRequest(request);
		return this.#mutate(async (state) => {
			const existing = state.records.get(request.id);
			if (existing) {
				if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
					throw new SchedulerError(
						`Schedule ${request.id} already exists with a different payload`,
					);
				}
				return existing;
			}
			const equivalent = [...state.records.values()].find(
				(record) =>
					(record.status === "scheduled" || record.status === "claimed") &&
					record.request.coalesceKey === request.coalesceKey &&
					JSON.stringify(record.request.command) ===
						JSON.stringify(request.command),
			);
			if (equivalent) return equivalent;
			const event = await this.#appendEvent(state, {
				type: "scheduled",
				scheduleId: request.id,
				request,
			});
			this.#apply(state.records, event);
			return this.#requireRecord(state.records, request.id);
		});
	}

	async claimDue(
		workerId: string,
		leaseMs: number,
	): Promise<ScheduleRecord | null> {
		this.#assertClaimArguments(workerId, leaseMs);
		return this.#mutate(async (state) => {
			const now = this.#now();
			const candidate = [...state.records.values()]
				.filter(
					(record) =>
						(record.status === "scheduled" &&
							Date.parse(record.nextDeadline) <= now) ||
						(record.status === "claimed" &&
							record.leaseUntil !== undefined &&
							Date.parse(record.leaseUntil) <= now),
				)
				.sort(compareRecords)[0];
			if (!candidate) return null;
			const event = await this.#appendEvent(state, {
				type: "claimed",
				scheduleId: candidate.request.id,
				workerId,
				leaseUntil: new Date(now + leaseMs).toISOString(),
				fencingToken: candidate.fencingToken + 1,
			});
			this.#apply(state.records, event);
			return this.#requireRecord(state.records, candidate.request.id);
		});
	}

	async deliverDue(
		workerId: string,
		leaseMs: number,
	): Promise<ScheduleRecord | null> {
		const claimed = await this.claimDue(workerId, leaseMs);
		if (!claimed) return null;
		try {
			await this.commandJournal.enqueue(claimed.request.command);
			return await this.markDelivered(
				claimed.request.id,
				workerId,
				claimed.fencingToken,
			);
		} catch (error) {
			await this.recordFailure(
				claimed.request.id,
				workerId,
				claimed.fencingToken,
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	async markDelivered(
		scheduleId: string,
		workerId: string,
		fencingToken: number,
	): Promise<ScheduleRecord> {
		return this.#mutate(async (state) => {
			this.#requireActiveClaim(
				state.records,
				scheduleId,
				workerId,
				fencingToken,
			);
			const event = await this.#appendEvent(state, {
				type: "delivered",
				scheduleId,
				workerId,
				fencingToken,
			});
			this.#apply(state.records, event);
			return this.#requireRecord(state.records, scheduleId);
		});
	}

	async recordFailure(
		scheduleId: string,
		workerId: string,
		fencingToken: number,
		error: string,
	): Promise<ScheduleRecord> {
		if (error.trim().length === 0) {
			throw new SchedulerError("Failure evidence must not be empty");
		}
		return this.#mutate(async (state) => {
			const record = this.#requireActiveClaim(
				state.records,
				scheduleId,
				workerId,
				fencingToken,
			);
			const retryCount = record.retryCount + 1;
			const exhausted = retryCount >= this.#maxRetries;
			const event = await this.#appendEvent(state, {
				type: exhausted ? "failed" : "retry_scheduled",
				scheduleId,
				workerId,
				fencingToken,
				retryCount,
				nextDeadline: exhausted
					? record.nextDeadline
					: new Date(
							this.#now() + this.#retryDelay(scheduleId, retryCount),
						).toISOString(),
				error,
			});
			this.#apply(state.records, event);
			return this.#requireRecord(state.records, scheduleId);
		});
	}

	async list(): Promise<ScheduleRecord[]> {
		return this.#withLock(async () => {
			const state = await this.#load();
			return [...state.records.values()].sort(compareRecords);
		});
	}

	async compact(): Promise<void> {
		await this.#withLock(async () => {
			const state = await this.#load();
			const nextGeneration = state.manifest.activeGeneration + 1;
			const finalDirectory = this.#generationPath(nextGeneration);
			const temporaryDirectory = `${finalDirectory}.tmp-${randomUUID()}`;
			await mkdir(temporaryDirectory, { recursive: true });
			const snapshot = withChecksum({
				schemaVersion: 1 as const,
				sequence: state.sequence,
				records: [...state.records.values()],
			});
			try {
				await writeFile(
					join(temporaryDirectory, SNAPSHOT_FILE),
					`${JSON.stringify(snapshot)}\n`,
					{ flag: "wx" },
				);
				await writeFile(join(temporaryDirectory, EVENTS_FILE), "", {
					flag: "wx",
				});
				await this.#readSnapshot(join(temporaryDirectory, SNAPSHOT_FILE));
				await rename(temporaryDirectory, finalDirectory);
				const manifest: SchedulerManifest = {
					schemaVersion: 1,
					activeGeneration: nextGeneration,
					previousGeneration: state.manifest.activeGeneration,
				};
				await this.#writeAtomic(this.#manifestPath, manifest);
			} catch (error) {
				await rm(temporaryDirectory, { recursive: true, force: true });
				throw error;
			}
		});
	}

	async #mutate<T>(
		operation: (state: SchedulerState) => Promise<T>,
	): Promise<T> {
		return this.#withLock(async () => operation(await this.#load()));
	}

	async #withLock<T>(operation: () => Promise<T>): Promise<T> {
		const release = await this.#acquireLock();
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	async #load(): Promise<SchedulerState> {
		await this.#ensureStorage();
		const manifest = await this.#readManifest();
		const generationPath = this.#generationPath(manifest.activeGeneration);
		const snapshot = await this.#readSnapshot(
			join(generationPath, SNAPSHOT_FILE),
		);
		const records = new Map(
			snapshot.records.map((record) => [record.request.id, record]),
		);
		let sequence = snapshot.sequence;
		const raw = await readFile(join(generationPath, EVENTS_FILE), "utf8");
		for (const [index, line] of raw
			.split("\n")
			.filter((entry) => entry.length > 0)
			.entries()) {
			const event = this.#parseEvent(line, index + 1);
			if (event.sequence !== sequence + 1) {
				throw new SchedulerError(
					`Scheduler event sequence ${event.sequence} does not follow ${sequence}`,
				);
			}
			this.#apply(records, event);
			sequence = event.sequence;
		}
		return { manifest, records, sequence };
	}

	async #appendEvent(
		state: SchedulerState,
		fields: Omit<
			ScheduleEvent,
			"schemaVersion" | "sequence" | "at" | "checksum"
		>,
	): Promise<ScheduleEvent> {
		const event = withChecksum({
			schemaVersion: 1 as const,
			sequence: state.sequence + 1,
			at: this.#isoNow(),
			...fields,
		});
		await appendFile(
			join(this.#generationPath(state.manifest.activeGeneration), EVENTS_FILE),
			`${JSON.stringify(event)}\n`,
		);
		state.sequence = event.sequence;
		return event;
	}

	#apply(records: Map<string, ScheduleRecord>, event: ScheduleEvent): void {
		if (event.type === "scheduled") {
			if (!event.request || records.has(event.scheduleId)) {
				throw new SchedulerError(
					`Invalid scheduled event for ${event.scheduleId}`,
				);
			}
			this.#assertRequest(event.request);
			records.set(event.scheduleId, {
				request: event.request,
				status: "scheduled",
				retryCount: 0,
				nextDeadline: event.request.deadline,
				fencingToken: 0,
			});
			return;
		}
		const record = this.#requireRecord(records, event.scheduleId);
		if (event.type === "claimed") {
			if (
				!event.workerId ||
				!event.leaseUntil ||
				event.fencingToken !== record.fencingToken + 1
			) {
				throw new SchedulerError(`Invalid claim event for ${event.scheduleId}`);
			}
			records.set(event.scheduleId, {
				...record,
				status: "claimed",
				workerId: event.workerId,
				leaseUntil: event.leaseUntil,
				fencingToken: event.fencingToken,
			});
			return;
		}
		if (
			!event.workerId ||
			event.fencingToken === undefined ||
			record.status !== "claimed" ||
			record.workerId !== event.workerId ||
			record.fencingToken !== event.fencingToken
		) {
			throw new SchedulerError(
				`Invalid ${event.type} event for ${event.scheduleId}`,
			);
		}
		if (event.type === "delivered") {
			records.set(event.scheduleId, {
				...record,
				status: "delivered",
				leaseUntil: undefined,
				deliveredAt: event.at,
			});
			return;
		}
		if (
			event.retryCount !== record.retryCount + 1 ||
			!event.error ||
			!event.nextDeadline
		) {
			throw new SchedulerError(
				`Invalid ${event.type} event for ${event.scheduleId}`,
			);
		}
		if (event.type === "retry_scheduled") {
			records.set(event.scheduleId, {
				...record,
				status: "scheduled",
				retryCount: event.retryCount,
				nextDeadline: event.nextDeadline,
				workerId: undefined,
				leaseUntil: undefined,
				lastError: event.error,
			});
			return;
		}
		records.set(event.scheduleId, {
			...record,
			status: "failed",
			retryCount: event.retryCount,
			leaseUntil: undefined,
			lastError: event.error,
			failedAt: event.at,
		});
	}

	#requireActiveClaim(
		records: Map<string, ScheduleRecord>,
		scheduleId: string,
		workerId: string,
		fencingToken: number,
	): ScheduleRecord {
		const record = this.#requireRecord(records, scheduleId);
		if (
			record.status !== "claimed" ||
			record.workerId !== workerId ||
			record.fencingToken !== fencingToken
		) {
			throw new SchedulerError(`Stale claim for schedule ${scheduleId}`);
		}
		return record;
	}

	#requireRecord(
		records: Map<string, ScheduleRecord>,
		scheduleId: string,
	): ScheduleRecord {
		const record = records.get(scheduleId);
		if (!record) throw new SchedulerError(`Unknown schedule ${scheduleId}`);
		return record;
	}

	#retryDelay(scheduleId: string, retryCount: number): number {
		const exponential = this.#baseRetryMs * 2 ** (retryCount - 1);
		const digest = createHash("sha256")
			.update(`${scheduleId}:${retryCount}`)
			.digest();
		const jitter = digest.readUInt32BE(0) % (this.#baseRetryMs + 1);
		return exponential + jitter;
	}

	#assertRequest(request: ScheduleRequest): void {
		if (
			request.schemaVersion !== 1 ||
			request.id.trim().length === 0 ||
			request.coalesceKey.trim().length === 0 ||
			!Number.isFinite(Date.parse(request.deadline))
		) {
			throw new SchedulerError("Schedule request is invalid");
		}
		const command = request.command;
		if (
			command.schemaVersion !== 1 ||
			command.id.trim().length === 0 ||
			command.cwd.trim().length === 0 ||
			command.sessionFile.trim().length === 0 ||
			command.prompt.trim().length === 0 ||
			!Number.isFinite(Date.parse(command.createdAt))
		) {
			throw new SchedulerError("Scheduled command is invalid");
		}
	}

	#assertClaimArguments(workerId: string, leaseMs: number): void {
		if (workerId.trim().length === 0) {
			throw new SchedulerError("Worker ID must not be empty");
		}
		if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
			throw new SchedulerError("Lease duration must be a positive integer");
		}
	}

	async #ensureStorage(): Promise<void> {
		const existingManifest = await this.#readOptional(this.#manifestPath);
		if (existingManifest !== null) return;
		const generationPath = this.#generationPath(1);
		await mkdir(generationPath, { recursive: true });
		const snapshot = withChecksum({
			schemaVersion: 1 as const,
			sequence: 0,
			records: [] as ScheduleRecord[],
		});
		await writeFile(
			join(generationPath, SNAPSHOT_FILE),
			`${JSON.stringify(snapshot)}\n`,
			{ flag: "wx" },
		);
		await writeFile(join(generationPath, EVENTS_FILE), "", { flag: "wx" });
		await this.#readSnapshot(join(generationPath, SNAPSHOT_FILE));
		await this.#writeAtomic(this.#manifestPath, {
			schemaVersion: 1,
			activeGeneration: 1,
		} satisfies SchedulerManifest);
	}

	async #readManifest(): Promise<SchedulerManifest> {
		const raw = await readFile(this.#manifestPath, "utf8");
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new SchedulerError("Scheduler manifest is invalid JSON", {
				cause: error,
			});
		}
		if (
			!value ||
			typeof value !== "object" ||
			(value as SchedulerManifest).schemaVersion !== 1 ||
			!Number.isInteger((value as SchedulerManifest).activeGeneration) ||
			(value as SchedulerManifest).activeGeneration <= 0
		) {
			throw new SchedulerError("Scheduler manifest is invalid");
		}
		return value as SchedulerManifest;
	}

	async #readSnapshot(path: string): Promise<SchedulerSnapshot> {
		const raw = await readFile(path, "utf8");
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new SchedulerError("Scheduler snapshot is invalid JSON", {
				cause: error,
			});
		}
		if (
			!value ||
			typeof value !== "object" ||
			(value as SchedulerSnapshot).schemaVersion !== 1 ||
			!Number.isInteger((value as SchedulerSnapshot).sequence) ||
			(value as SchedulerSnapshot).sequence < 0 ||
			!Array.isArray((value as SchedulerSnapshot).records)
		) {
			throw new SchedulerError("Scheduler snapshot is invalid");
		}
		const snapshot = value as SchedulerSnapshot;
		const { checksum, ...unsigned } = snapshot;
		if (checksum !== calculateChecksum(unsigned)) {
			throw new SchedulerError("Scheduler snapshot checksum mismatch");
		}
		for (const record of snapshot.records) this.#assertRecord(record);
		return snapshot;
	}

	#parseEvent(raw: string, line: number): ScheduleEvent {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new SchedulerError(`Scheduler event line ${line} is invalid JSON`, {
				cause: error,
			});
		}
		if (!value || typeof value !== "object") {
			throw new SchedulerError(`Scheduler event line ${line} is invalid`);
		}
		const event = value as ScheduleEvent;
		const { checksum, ...unsigned } = event;
		if (
			event.schemaVersion !== 1 ||
			!Number.isInteger(event.sequence) ||
			event.sequence <= 0 ||
			!Number.isFinite(Date.parse(event.at)) ||
			checksum !== calculateChecksum(unsigned)
		) {
			throw new SchedulerError(`Scheduler event line ${line} is invalid`);
		}
		return event;
	}

	#assertRecord(record: ScheduleRecord): void {
		this.#assertRequest(record.request);
		if (
			!Number.isInteger(record.retryCount) ||
			record.retryCount < 0 ||
			!Number.isInteger(record.fencingToken) ||
			record.fencingToken < 0 ||
			!Number.isFinite(Date.parse(record.nextDeadline)) ||
			!["scheduled", "claimed", "delivered", "failed"].includes(record.status)
		) {
			throw new SchedulerError(
				`Snapshot record ${record.request.id} is invalid`,
			);
		}
	}

	async #writeAtomic(path: string, value: unknown): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.tmp-${randomUUID()}`;
		await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
		await rename(temporary, path);
	}

	#generationPath(generation: number): string {
		return join(this.#generationsPath, String(generation));
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
		await mkdir(this.#directory, { recursive: true });
		return acquireFileLock(this.#lockPath, {
			timeoutMs: this.#lockTimeoutMs,
			staleMs: this.#lockStaleMs,
		});
	}
}

function compareRecords(left: ScheduleRecord, right: ScheduleRecord): number {
	return (
		left.nextDeadline.localeCompare(right.nextDeadline) ||
		left.request.id.localeCompare(right.request.id)
	);
}

function withChecksum<T extends object>(value: T): T & { checksum: string } {
	return { ...value, checksum: calculateChecksum(value) };
}

function calculateChecksum(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
