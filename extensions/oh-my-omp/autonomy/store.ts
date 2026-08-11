import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

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

export class AutonomyStore {
	readonly statePath: string;
	readonly journalPath: string;

	constructor(private readonly root: string) {
		this.statePath = join(root, STATE_DIRECTORY, STATE_FILE);
		this.journalPath = join(root, STATE_DIRECTORY, JOURNAL_FILE);
	}

	async load(): Promise<AutonomyRun | null> {
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

	async save(state: AutonomyRun): Promise<void> {
		this.assertState(state, "state");
		const directory = dirname(this.statePath);
		await mkdir(directory, { recursive: true });

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
		await appendFile(this.journalPath, `${JSON.stringify(event)}\n`, "utf8");

		const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
		await writeFile(
			temporaryPath,
			`${JSON.stringify(state, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, this.statePath);
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
			!Array.isArray(state.gates)
		) {
			throw new AutonomyStoreError(`Autonomy ${source} has an invalid shape`);
		}
	}
}
