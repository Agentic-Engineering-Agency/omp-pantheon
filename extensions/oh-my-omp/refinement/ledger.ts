import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { acquireFileLock } from "../file-lock";
import {
	appendPrivateFile,
	assertNoSymlinkComponents,
	ensurePrivateDirectory,
} from "../private-files";

import type {
	CreateRefinementProposal,
	RefinementLedgerEvent,
	RefinementProposal,
	RefinementStatus,
} from "./schema";

const LEDGER_PATH = join(".pi", "refinement", "ledger.jsonl");
const QUARANTINE_PATH = join(".pi", "refinement", "quarantine.jsonl");
const SNAPSHOT_DIRECTORY = join(".pi", "refinement", "snapshots");
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

interface RefinementSnapshot {
	schemaVersion: 1;
	proposalId: string;
	artifactPath: string;
	baseHash: string;
	contentBase64: string;
	mode: number;
	checksum: string;
}

export class RefinementLedgerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RefinementLedgerError";
	}
}

export interface RefinementLedgerOptions {
	now?: () => string;
	createId?: () => string;
}

export class RefinementLedger {
	private readonly ledgerPath: string;
	private readonly lockPath: string;
	private readonly quarantinePath: string;
	private readonly now: () => string;
	private readonly createId: () => string;

	constructor(
		private readonly root: string,
		options: RefinementLedgerOptions = {},
	) {
		this.ledgerPath = join(root, LEDGER_PATH);
		this.lockPath = `${this.ledgerPath}.lock`;
		this.quarantinePath = join(root, QUARANTINE_PATH);
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? randomUUID;
	}

	async list(): Promise<RefinementProposal[]> {
		const events = await this.readEvents();
		const proposals = new Map<string, RefinementProposal>();
		for (const event of events) {
			proposals.set(event.proposal.id, event.proposal);
		}
		return [...proposals.values()];
	}

	async propose(args: CreateRefinementProposal): Promise<RefinementProposal> {
		const artifactPath = normalize(args.artifactPath);
		if (
			args.artifactPath.trim().length === 0 ||
			isAbsolute(args.artifactPath) ||
			artifactPath === ".." ||
			artifactPath.startsWith(`..${sep}`)
		) {
			throw new RefinementLedgerError(
				"Refinement artifact path must stay within the project",
			);
		}
		for (const [name, value] of Object.entries({
			baseHash: args.baseHash,
			contentHash: args.contentHash,
			author: args.author,
			source: args.source,
		})) {
			if (value.trim().length === 0) {
				throw new RefinementLedgerError(`Refinement ${name} must not be empty`);
			}
		}

		const timestamp = this.now();
		const id = this.createId();
		if (!SAFE_ID.test(id)) {
			throw new RefinementLedgerError(
				"Refinement proposal ID contains unsafe path characters",
			);
		}
		const proposal: RefinementProposal = {
			schemaVersion: 1,
			id,
			artifactPath,
			baseHash: args.baseHash,
			contentHash: args.contentHash,
			author: args.author,
			source: args.source,
			parentId: args.parentId,
			status: "proposed",
			validationEvidence: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		return this.withLock(async () => {
			const events = await this.readEvents();
			if (this.snapshot(events).some((item) => item.id === proposal.id)) {
				throw new RefinementLedgerError(
					`Refinement proposal already exists: ${proposal.id}`,
				);
			}
			await this.append(proposal, events.length + 1);
			return proposal;
		});
	}

	async validate(id: string, evidence: string): Promise<RefinementProposal> {
		if (evidence.trim().length === 0) {
			throw new RefinementLedgerError("Validation evidence must not be empty");
		}
		return this.update(id, (proposal) => {
			this.requireStatus(proposal, "proposed", "validate");
			return {
				...proposal,
				status: "validated",
				validationEvidence: [...proposal.validationEvidence, evidence.trim()],
			};
		});
	}

	async approve(id: string, approvedBy: string): Promise<RefinementProposal> {
		if (approvedBy.trim().length === 0) {
			throw new RefinementLedgerError("Approver must not be empty");
		}
		return this.update(id, (proposal) => {
			this.requireStatus(proposal, "validated", "approve");
			return {
				...proposal,
				status: "approved",
				approvedBy: approvedBy.trim(),
			};
		});
	}

	async activate(id: string, currentHash: string): Promise<RefinementProposal> {
		return this.withLock(async () => {
			const events = await this.readEvents();
			const proposals = this.snapshot(events);
			const proposal = this.requireProposal(proposals, id);
			this.requireStatus(proposal, "approved", "activate");
			const conflict = proposals.find(
				(item) =>
					item.id !== id &&
					item.artifactPath === proposal.artifactPath &&
					item.status === "active",
			);
			if (conflict) {
				throw new RefinementLedgerError(
					`Artifact already has active proposal ${conflict.id}`,
				);
			}
			const artifactPath = await this.resolveArtifactPath(proposal);
			const [content, metadata] = await Promise.all([
				readFile(artifactPath),
				stat(artifactPath),
			]);
			const observedHash = this.hashContent(content);
			if (proposal.baseHash !== currentHash || observedHash !== currentHash) {
				throw new RefinementLedgerError(
					`Refinement base hash ${proposal.baseHash} does not match current hash ${observedHash}`,
				);
			}
			await this.writeSnapshot(proposal, content, metadata.mode & 0o777);
			const next = {
				...proposal,
				status: "active" as const,
				updatedAt: this.now(),
			};
			await this.append(next, events.length + 1);
			return next;
		});
	}

	async reject(id: string, reason: string): Promise<RefinementProposal> {
		return this.update(id, (proposal) => {
			if (
				["active", "rolled_back", "rejected", "quarantined"].includes(
					proposal.status,
				)
			) {
				throw new RefinementLedgerError(
					`Cannot reject refinement in ${proposal.status} status`,
				);
			}
			return {
				...proposal,
				status: "rejected",
				reason: this.requireReason(reason),
			};
		});
	}

	async rollback(id: string, reason: string): Promise<RefinementProposal> {
		const rollbackReason = this.requireReason(reason);
		return this.withLock(async () => {
			const events = await this.readEvents();
			const proposals = this.snapshot(events);
			const proposal = this.requireProposal(proposals, id);
			this.requireStatus(proposal, "active", "roll back");
			const snapshot = await this.readSnapshot(proposal);
			const artifactPath = await this.resolveArtifactPath(proposal);
			const current = await readFile(artifactPath);
			const currentHash = this.hashContent(current);
			if (
				currentHash !== proposal.contentHash &&
				currentHash !== proposal.baseHash
			) {
				throw new RefinementLedgerError(
					`Cannot roll back ${proposal.id}: artifact hash ${currentHash} matches neither active nor base content`,
				);
			}
			await this.restoreArtifact(artifactPath, snapshot, currentHash);
			const next = {
				...proposal,
				status: "rolled_back" as const,
				reason: rollbackReason,
				updatedAt: this.now(),
			};
			await this.append(next, events.length + 1);
			return next;
		});
	}

	async quarantine(id: string, reason: string): Promise<RefinementProposal> {
		return this.update(id, (proposal) => {
			if (proposal.status === "rolled_back") {
				throw new RefinementLedgerError(
					"Cannot quarantine a rolled-back refinement",
				);
			}
			return {
				...proposal,
				status: "quarantined",
				reason: this.requireReason(reason),
			};
		});
	}

	private async update(
		id: string,
		change: (
			proposal: RefinementProposal,
			proposals: RefinementProposal[],
		) => RefinementProposal,
	): Promise<RefinementProposal> {
		return this.withLock(async () => {
			const events = await this.readEvents();
			const proposals = this.snapshot(events);
			const proposal = this.requireProposal(proposals, id);
			const next = {
				...change(proposal, proposals),
				updatedAt: this.now(),
			};
			await this.append(next, events.length + 1);
			return next;
		});
	}

	private snapshot(events: RefinementLedgerEvent[]): RefinementProposal[] {
		const proposals = new Map<string, RefinementProposal>();
		for (const event of events) {
			proposals.set(event.proposal.id, event.proposal);
		}
		return [...proposals.values()];
	}

	private requireProposal(
		proposals: RefinementProposal[],
		id: string,
	): RefinementProposal {
		const proposal = proposals.find((item) => item.id === id);
		if (!proposal) {
			throw new RefinementLedgerError(`Unknown refinement proposal: ${id}`);
		}
		return proposal;
	}

	private async resolveArtifactPath(
		proposal: RefinementProposal,
	): Promise<string> {
		const path = join(this.root, proposal.artifactPath);
		await assertNoSymlinkComponents(this.root, path);
		return path;
	}

	private hashContent(content: Uint8Array): string {
		return `sha256:${createHash("sha256").update(content).digest("hex")}`;
	}

	private snapshotPath(proposal: RefinementProposal): string {
		if (!SAFE_ID.test(proposal.id)) {
			throw new RefinementLedgerError(
				"Refinement proposal ID contains unsafe path characters",
			);
		}
		return join(this.root, SNAPSHOT_DIRECTORY, `${proposal.id}.json`);
	}

	private async writeSnapshot(
		proposal: RefinementProposal,
		content: Uint8Array,
		mode: number,
	): Promise<void> {
		const snapshotPath = this.snapshotPath(proposal);
		const snapshotDirectory = dirname(snapshotPath);
		await assertNoSymlinkComponents(this.root, snapshotPath);
		await ensurePrivateDirectory(snapshotDirectory);
		const snapshotWithoutChecksum = {
			schemaVersion: 1 as const,
			proposalId: proposal.id,
			artifactPath: proposal.artifactPath,
			baseHash: proposal.baseHash,
			contentBase64: Buffer.from(content).toString("base64"),
			mode,
		};
		const snapshot: RefinementSnapshot = {
			...snapshotWithoutChecksum,
			checksum: createHash("sha256")
				.update(JSON.stringify(snapshotWithoutChecksum))
				.digest("hex"),
		};
		const temporaryPath = `${snapshotPath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await rename(temporaryPath, snapshotPath);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	private async readSnapshot(
		proposal: RefinementProposal,
	): Promise<RefinementSnapshot> {
		const snapshotPath = this.snapshotPath(proposal);
		await assertNoSymlinkComponents(this.root, snapshotPath);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(snapshotPath, "utf8"));
		} catch (error) {
			throw new RefinementLedgerError(
				`Refinement rollback snapshot is unavailable for ${proposal.id}`,
				{ cause: error },
			);
		}
		if (!this.isRefinementSnapshot(parsed)) {
			throw new RefinementLedgerError(
				`Refinement rollback snapshot is invalid for ${proposal.id}`,
			);
		}
		const snapshot = parsed;
		const { checksum, ...snapshotWithoutChecksum } = snapshot;
		const expectedChecksum = createHash("sha256")
			.update(JSON.stringify(snapshotWithoutChecksum))
			.digest("hex");
		const content = Buffer.from(snapshot.contentBase64, "base64");
		if (
			snapshot.schemaVersion !== 1 ||
			snapshot.proposalId !== proposal.id ||
			snapshot.artifactPath !== proposal.artifactPath ||
			snapshot.baseHash !== proposal.baseHash ||
			!Number.isInteger(snapshot.mode) ||
			snapshot.mode < 0 ||
			snapshot.mode > 0o777 ||
			checksum !== expectedChecksum ||
			this.hashContent(content) !== proposal.baseHash
		) {
			throw new RefinementLedgerError(
				`Refinement rollback snapshot is invalid for ${proposal.id}`,
			);
		}
		return snapshot;
	}

	private isRefinementSnapshot(value: unknown): value is RefinementSnapshot {
		return (
			value !== null &&
			typeof value === "object" &&
			"schemaVersion" in value &&
			value.schemaVersion === 1 &&
			"proposalId" in value &&
			typeof value.proposalId === "string" &&
			"artifactPath" in value &&
			typeof value.artifactPath === "string" &&
			"baseHash" in value &&
			typeof value.baseHash === "string" &&
			"contentBase64" in value &&
			typeof value.contentBase64 === "string" &&
			"mode" in value &&
			typeof value.mode === "number" &&
			"checksum" in value &&
			typeof value.checksum === "string"
		);
	}

	private async restoreArtifact(
		artifactPath: string,
		snapshot: RefinementSnapshot,
		expectedCurrentHash: string,
	): Promise<void> {
		await assertNoSymlinkComponents(this.root, artifactPath);
		const temporaryPath = `${artifactPath}.${randomUUID()}.rollback`;
		try {
			await writeFile(
				temporaryPath,
				Buffer.from(snapshot.contentBase64, "base64"),
				{
					flag: "wx",
					mode: snapshot.mode,
				},
			);
			await chmod(temporaryPath, snapshot.mode);
			await assertNoSymlinkComponents(this.root, artifactPath);
			const currentHash = this.hashContent(await readFile(artifactPath));
			if (currentHash !== expectedCurrentHash) {
				throw new RefinementLedgerError(
					`Cannot roll back snapshot: artifact changed during restoration (${currentHash})`,
				);
			}
			await assertNoSymlinkComponents(this.root, artifactPath);
			await rename(temporaryPath, artifactPath);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await assertNoSymlinkComponents(this.root, this.ledgerPath);
		await ensurePrivateDirectory(join(this.root, ".pi", "refinement"));
		const release = await acquireFileLock(this.lockPath);
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	private requireStatus(
		proposal: RefinementProposal,
		expected: RefinementStatus,
		action: string,
	): void {
		if (proposal.status !== expected) {
			throw new RefinementLedgerError(
				`Cannot ${action} refinement ${proposal.id}: expected ${expected}, found ${proposal.status}`,
			);
		}
	}

	private requireReason(reason: string): string {
		if (reason.trim().length === 0) {
			throw new RefinementLedgerError("Refinement reason must not be empty");
		}
		return reason.trim();
	}

	private async append(
		proposal: RefinementProposal,
		sequence: number,
	): Promise<void> {
		const eventWithoutChecksum = {
			schemaVersion: 1 as const,
			sequence,
			at: proposal.updatedAt,
			proposal,
		};
		const checksum = createHash("sha256")
			.update(JSON.stringify(eventWithoutChecksum))
			.digest("hex");
		await assertNoSymlinkComponents(this.root, this.ledgerPath);
		await appendPrivateFile(
			this.ledgerPath,
			`${JSON.stringify({ ...eventWithoutChecksum, checksum })}\n`,
		);
	}

	private async readEvents(): Promise<RefinementLedgerEvent[]> {
		await assertNoSymlinkComponents(this.root, this.ledgerPath);
		let raw: string;
		try {
			raw = await readFile(this.ledgerPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const events: RefinementLedgerEvent[] = [];
		for (const [index, line] of raw.split("\n").entries()) {
			if (line.length === 0) continue;
			try {
				const event = JSON.parse(line) as RefinementLedgerEvent;
				const expectedSequence = events.length + 1;
				const { checksum, ...eventWithoutChecksum } = event;
				const expectedChecksum = createHash("sha256")
					.update(JSON.stringify(eventWithoutChecksum))
					.digest("hex");
				if (
					event.schemaVersion !== 1 ||
					event.sequence !== expectedSequence ||
					event.proposal?.schemaVersion !== 1 ||
					checksum !== expectedChecksum
				) {
					throw new RefinementLedgerError("invalid event envelope");
				}
				events.push(event);
			} catch (error) {
				await this.quarantineLine(index + 1, line, error);
				throw new RefinementLedgerError(
					`Refinement journal entry ${index + 1} was quarantined`,
					{ cause: error },
				);
			}
		}
		return events;
	}

	private async quarantineLine(
		lineNumber: number,
		raw: string,
		error: unknown,
	): Promise<void> {
		await assertNoSymlinkComponents(this.root, this.quarantinePath);
		await appendPrivateFile(
			this.quarantinePath,
			`${JSON.stringify({
				at: this.now(),
				lineNumber,
				raw,
				reason: error instanceof Error ? error.message : String(error),
			})}\n`,
		);
	}
}
