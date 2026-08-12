import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { acquireFileLock } from "../file-lock";
import {
	appendPrivateFile,
	assertNoSymlinkComponents,
	ensurePrivateDirectory,
} from "../private-files";

import type {
	AutonomyGateRecord,
	AutonomyJournalEvent,
	AutonomyRun,
	AutonomyTerminalIntent,
} from "./types";

const STATE_DIRECTORY = join(".pi", "autonomy");
const STATE_FILE = "state.json";
const JOURNAL_FILE = "events.jsonl";

export class AutonomyStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AutonomyStoreError";
	}
}

interface AutonomyStoreOptions {
	stateDirectory?: string;
}

export type AutonomyStateUpdate = (state: AutonomyRun) => AutonomyRun;

export class AutonomyStore {
	readonly statePath: string;
	readonly journalPath: string;
	readonly lockPath: string;
	private readonly projectRoot: string;
	private readonly projectState: boolean;

	constructor(root: string, options: AutonomyStoreOptions = {}) {
		this.projectRoot = root;
		this.projectState = options.stateDirectory === undefined;
		const directory = options.stateDirectory ?? join(root, STATE_DIRECTORY);
		this.statePath = join(directory, STATE_FILE);
		this.journalPath = join(directory, JOURNAL_FILE);
		this.lockPath = `${this.statePath}.lock`;
	}

	async load(): Promise<AutonomyRun | null> {
		await this.assertSafeStatePath();
		const [snapshot, journal] = await Promise.all([
			this.readOptional(this.statePath),
			this.readOptional(this.journalPath),
		]);
		if (snapshot === null && journal === null) return null;
		if (journal === null) {
			throw new AutonomyStoreError(
				"Autonomy journal is missing while a snapshot exists",
			);
		}

		const events = this.parseJournal(journal);
		const latest = events.at(-1)?.state ?? null;
		if (snapshot === null) return latest;

		const snapshotState = this.parseState(snapshot, "snapshot");
		if (latest === null) {
			throw new AutonomyStoreError(
				"Autonomy journal is empty while a snapshot exists",
			);
		}
		if (snapshotState.revision > latest.revision) {
			throw new AutonomyStoreError("Autonomy snapshot is ahead of its journal");
		}
		return latest.revision >= snapshotState.revision ? latest : snapshotState;
	}

	async save(state: AutonomyRun, expectedRevision: number): Promise<void> {
		await this.assertSafeStatePath();
		this.assertState(state, "state");
		if (
			!Number.isInteger(expectedRevision) ||
			expectedRevision < 0 ||
			state.revision !== expectedRevision + 1
		) {
			throw new AutonomyStoreError(
				"Autonomy save requires the immediately preceding revision",
			);
		}
		const directory = dirname(this.statePath);
		await ensurePrivateDirectory(directory);
		const release = await acquireFileLock(this.lockPath);
		try {
			const current = await this.load();
			const currentRevision = current?.revision ?? 0;
			if (currentRevision !== expectedRevision) {
				throw new AutonomyStoreError(
					`Autonomy revision conflict: expected ${expectedRevision}, found ${currentRevision}`,
				);
			}
			await this.writeLocked(state);
		} finally {
			await release();
		}
	}

	async update(
		expectedRunId: string,
		change: AutonomyStateUpdate,
	): Promise<AutonomyRun> {
		await this.assertSafeStatePath();
		const directory = dirname(this.statePath);
		await ensurePrivateDirectory(directory);
		const release = await acquireFileLock(this.lockPath);
		try {
			const current = await this.load();
			if (current === null) {
				throw new AutonomyStoreError("No autonomy run exists");
			}
			if (current.id !== expectedRunId) {
				throw new AutonomyStoreError(
					`Autonomy run changed from ${expectedRunId} to ${current.id}`,
				);
			}
			const next = change(current);
			if (next.id !== current.id || next.revision !== current.revision + 1) {
				throw new AutonomyStoreError(
					"Atomic autonomy update must preserve the run and advance one revision",
				);
			}
			this.assertState(next, "state");
			await this.writeLocked(next);
			return next;
		} finally {
			await release();
		}
	}
	async updateCurrent(change: AutonomyStateUpdate): Promise<AutonomyRun> {
		await this.assertSafeStatePath();
		const directory = dirname(this.statePath);
		await ensurePrivateDirectory(directory);
		const release = await acquireFileLock(this.lockPath);
		try {
			const current = await this.load();
			if (current === null) {
				throw new AutonomyStoreError("No autonomy run exists");
			}
			const next = change(current);
			if (next.id !== current.id || next.revision !== current.revision + 1) {
				throw new AutonomyStoreError(
					"Atomic autonomy update must preserve the current run and advance one revision",
				);
			}
			this.assertState(next, "state");
			await this.writeLocked(next);
			return next;
		} finally {
			await release();
		}
	}

	private async writeLocked(state: AutonomyRun): Promise<void> {
		const eventWithoutChecksum = {
			schemaVersion: 1 as const,
			sequence: state.revision,
			at: state.updatedAt,
			state,
		};
		const checksum = createHash("sha256")
			.update(JSON.stringify(eventWithoutChecksum))
			.digest("hex");
		const event: AutonomyJournalEvent = {
			...eventWithoutChecksum,
			checksum,
		};
		await appendPrivateFile(this.journalPath, `${JSON.stringify(event)}\n`);

		const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporaryPath, this.statePath);
	}

	private async assertSafeStatePath(): Promise<void> {
		if (!this.projectState) return;
		for (const path of [this.statePath, this.journalPath, this.lockPath]) {
			await assertNoSymlinkComponents(this.projectRoot, path);
		}
	}

	private async readOptional(path: string): Promise<string | null> {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private parseJournal(raw: string): AutonomyJournalEvent[] {
		const lines = raw.split("\n").filter((line) => line.length > 0);
		const events: AutonomyJournalEvent[] = [];
		for (const [index, line] of lines.entries()) {
			let event: AutonomyJournalEvent;
			try {
				event = JSON.parse(line) as AutonomyJournalEvent;
			} catch (error) {
				throw new AutonomyStoreError(
					`Autonomy journal line ${index + 1} is invalid JSON`,
					{ cause: error },
				);
			}
			const expectedSequence = index + 1;
			if (event.sequence !== expectedSequence) {
				throw new AutonomyStoreError(
					`Autonomy journal sequence is non-contiguous at ${expectedSequence}`,
				);
			}
			const { checksum, ...eventWithoutChecksum } = event;
			const expectedChecksum = createHash("sha256")
				.update(JSON.stringify(eventWithoutChecksum))
				.digest("hex");
			if (checksum !== expectedChecksum) {
				throw new AutonomyStoreError(
					`Autonomy journal checksum mismatch at ${expectedSequence}`,
				);
			}
			this.assertState(event.state, `journal event ${expectedSequence}`);
			if (event.state.revision !== event.sequence) {
				throw new AutonomyStoreError(
					`Autonomy journal state revision mismatch at ${expectedSequence}`,
				);
			}
			events.push(event);
		}
		return events;
	}

	private parseState(raw: string, source: string): AutonomyRun {
		let state: AutonomyRun;
		try {
			state = JSON.parse(raw) as AutonomyRun;
		} catch (error) {
			throw new AutonomyStoreError(`Autonomy ${source} is invalid JSON`, {
				cause: error,
			});
		}
		this.assertState(state, source);
		return state;
	}

	private assertState(state: AutonomyRun, source: string): void {
		const validStatuses: AutonomyRun["status"][] = [
			"running",
			"waiting",
			"paused",
			"succeeded",
			"failed",
			"cancelled",
		];
		if (
			state.schemaVersion !== 1 ||
			typeof state.id !== "string" ||
			state.id.trim().length === 0 ||
			typeof state.task !== "string" ||
			state.task.trim().length === 0 ||
			!validStatuses.includes(state.status) ||
			!Number.isInteger(state.revision) ||
			state.revision < 1 ||
			!Number.isInteger(state.attempt) ||
			state.attempt < 1 ||
			!Number.isInteger(state.maxAttempts) ||
			state.maxAttempts < state.attempt ||
			!Number.isInteger(state.artifactRevision) ||
			state.artifactRevision < 0 ||
			!Array.isArray(state.gates) ||
			state.gates.length === 0 ||
			typeof state.verificationCommand !== "string" ||
			state.verificationCommand.trim().length === 0 ||
			typeof state.ownerSessionFile !== "string" ||
			state.ownerSessionFile.trim().length === 0 ||
			!isAbsolute(state.ownerSessionFile) ||
			!Number.isFinite(Date.parse(state.createdAt)) ||
			!Number.isFinite(Date.parse(state.updatedAt)) ||
			(state.nativeGoalId !== undefined &&
				(typeof state.nativeGoalId !== "string" ||
					state.nativeGoalId.trim().length === 0)) ||
			(state.artifactHash !== undefined &&
				(typeof state.artifactHash !== "string" ||
					state.artifactHash.trim().length === 0)) ||
			(state.lastError !== undefined && typeof state.lastError !== "string") ||
			(state.terminalIntent !== undefined &&
				((state.status !== "running" && state.status !== "waiting") ||
					!this.isValidTerminalIntent(state.terminalIntent))) ||
			(state.verificationLease !== undefined &&
				(typeof state.verificationLease !== "object" ||
					state.verificationLease === null ||
					typeof state.verificationLease.token !== "string" ||
					state.verificationLease.token.trim().length === 0 ||
					!Number.isFinite(Date.parse(state.verificationLease.startedAt))))
		) {
			throw new AutonomyStoreError(`Autonomy ${source} has an invalid shape`);
		}

		const gateIds = new Set<string>();
		for (const gate of state.gates as unknown[]) {
			if (
				!this.isValidGateRecord(gate, state.attempt, state.artifactRevision) ||
				gateIds.has(gate.id)
			) {
				throw new AutonomyStoreError(
					`Autonomy ${source} has an invalid gate record`,
				);
			}
			gateIds.add(gate.id);
		}
		if (
			state.status === "succeeded" &&
			state.gates.some((gate) => gate.status !== "pass")
		) {
			throw new AutonomyStoreError(
				`Autonomy ${source} succeeded without passing every gate`,
			);
		}
	}

	private isValidTerminalIntent(
		value: unknown,
	): value is AutonomyTerminalIntent {
		if (typeof value !== "object" || value === null) return false;
		const intent = value as Partial<AutonomyTerminalIntent>;
		return (
			typeof intent.status === "string" &&
			["paused", "succeeded", "failed", "cancelled"].includes(intent.status) &&
			typeof intent.commandId === "string" &&
			intent.commandId.trim().length > 0 &&
			typeof intent.requestedAt === "string" &&
			Number.isFinite(Date.parse(intent.requestedAt))
		);
	}

	private isValidGateRecord(
		value: unknown,
		attempt: number,
		artifactRevision: number,
	): value is AutonomyGateRecord {
		if (typeof value !== "object" || value === null) return false;
		const gate = value as Partial<AutonomyGateRecord>;
		if (
			typeof gate.id !== "string" ||
			gate.id.trim().length === 0 ||
			typeof gate.label !== "string" ||
			gate.label.trim().length === 0 ||
			!["pending", "pass", "fail"].includes(gate.status ?? "") ||
			gate.attempt !== attempt ||
			gate.artifactRevision !== artifactRevision ||
			typeof gate.requirement !== "object" ||
			gate.requirement === null
		) {
			return false;
		}

		const requirement = gate.requirement;
		let expectedReporter: AutonomyGateRecord["reporter"];
		switch (requirement.kind) {
			case "native-goal":
				expectedReporter = "native-goal-event";
				break;
			case "command":
				expectedReporter = "host-verifier";
				break;
			case "evalfly":
				if (
					typeof requirement.suite !== "string" ||
					!["smoke", "regression", "benchmark"].includes(requirement.suite) ||
					typeof requirement.commitRange !== "string" ||
					requirement.commitRange.trim().length === 0 ||
					typeof requirement.activatedAt !== "string" ||
					!Number.isFinite(Date.parse(requirement.activatedAt))
				) {
					return false;
				}
				expectedReporter = "evalfly-adapter";
				break;
			case "specsafe":
				if (
					typeof requirement.sliceId !== "string" ||
					requirement.sliceId.trim().length === 0 ||
					typeof requirement.beganAt !== "string" ||
					!Number.isFinite(Date.parse(requirement.beganAt)) ||
					typeof requirement.activatedAt !== "string" ||
					!Number.isFinite(Date.parse(requirement.activatedAt))
				) {
					return false;
				}
				expectedReporter = "specsafe-adapter";
				break;
			default:
				return false;
		}

		if (gate.status === "pending") {
			return (
				gate.reporter === undefined &&
				gate.evidence === undefined &&
				gate.updatedAt === undefined
			);
		}
		return (
			gate.reporter === expectedReporter &&
			typeof gate.evidence === "string" &&
			gate.evidence.trim().length > 0 &&
			typeof gate.updatedAt === "string" &&
			Number.isFinite(Date.parse(gate.updatedAt))
		);
	}
}
