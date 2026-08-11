import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acquireFileLock } from "../file-lock";
import {
	appendPrivateFile,
	assertNoSymlinkComponents,
	ensurePrivateDirectory,
} from "../private-files";

import type { AutonomyJournalEvent, AutonomyRun } from "./types";

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
		} finally {
			await release();
		}
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
		if (
			state.schemaVersion !== 1 ||
			typeof state.id !== "string" ||
			typeof state.task !== "string" ||
			!Number.isInteger(state.revision) ||
			state.revision < 1 ||
			!Number.isInteger(state.attempt) ||
			state.attempt < 1 ||
			!Array.isArray(state.gates) ||
			typeof state.verificationCommand !== "string" ||
			state.verificationCommand.trim().length === 0
		) {
			throw new AutonomyStoreError(`Autonomy ${source} has an invalid shape`);
		}
	}
}
