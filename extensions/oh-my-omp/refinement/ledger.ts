import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
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
		const proposal: RefinementProposal = {
			schemaVersion: 1,
			id: this.createId(),
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
		return this.update(id, (proposal, proposals) => {
			this.requireStatus(proposal, "approved", "activate");
			if (proposal.baseHash !== currentHash) {
				throw new RefinementLedgerError(
					`Refinement base hash ${proposal.baseHash} does not match current hash ${currentHash}`,
				);
			}
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
			return { ...proposal, status: "active" };
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
		return this.update(id, (proposal) => {
			this.requireStatus(proposal, "active", "roll back");
			return {
				...proposal,
				status: "rolled_back",
				reason: this.requireReason(reason),
			};
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
			const proposal = proposals.find((item) => item.id === id);
			if (!proposal) {
				throw new RefinementLedgerError(`Unknown refinement proposal: ${id}`);
			}
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
