export interface RetainedAgentBackend {
	retain(
		prompt: string,
		ownerSessionId: string,
	): Promise<{ id: string; handle: string }>;
	send(agentId: string, message: string): Promise<string>;
	release(agentId: string): Promise<void>;
}

export type RetainedAgentState = "active" | "released" | "expired";

export interface RetainedAgentRecord {
	id: string;
	handle: string;
	ownerSessionId: string;
	state: RetainedAgentState;
	createdAt: string;
	expiresAt: string;
}

interface RetainedAgentOptions {
	now?: () => number;
	maxTtlMs?: number;
}

export class RetainedAgentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetainedAgentError";
	}
}

const UNSUPPORTED_REASON =
	"OMP 17.2.14 eval.agent hard-codes one-shot disposal and exposes no keep-alive option";

export class RetainedAgentAdapter {
	readonly #records = new Map<string, RetainedAgentRecord>();
	readonly #now: () => number;
	readonly #maxTtlMs: number;
	#closed = false;

	constructor(
		private readonly backend?: RetainedAgentBackend,
		options: RetainedAgentOptions = {},
	) {
		this.#now = options.now ?? Date.now;
		this.#maxTtlMs = options.maxTtlMs ?? 3_600_000;
		if (!Number.isInteger(this.#maxTtlMs) || this.#maxTtlMs <= 0) {
			throw new RetainedAgentError(
				"Maximum retained-agent TTL must be positive",
			);
		}
	}

	capability(): { supported: true } | { supported: false; reason: string } {
		return this.backend
			? { supported: true }
			: { supported: false, reason: UNSUPPORTED_REASON };
	}

	async retain(
		prompt: string,
		ownerSessionId: string,
		ttlMs: number,
	): Promise<RetainedAgentRecord> {
		const backend = this.#requireOpenBackend();
		if (prompt.trim().length === 0 || ownerSessionId.trim().length === 0) {
			throw new RetainedAgentError(
				"Prompt and owner session must not be empty",
			);
		}
		if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > this.#maxTtlMs) {
			throw new RetainedAgentError(
				`Retained-agent TTL must be between 1 and ${this.#maxTtlMs} ms`,
			);
		}
		await this.sweepExpired();
		const createdAtMs = this.#now();
		const retained = await backend.retain(prompt, ownerSessionId);
		if (
			retained.id.trim().length === 0 ||
			retained.handle !== `agent://${retained.id}` ||
			this.#records.has(retained.id)
		) {
			await backend.release(retained.id);
			throw new RetainedAgentError(
				"Backend returned an invalid retained-agent handle",
			);
		}
		const record: RetainedAgentRecord = {
			...retained,
			ownerSessionId,
			state: "active",
			createdAt: new Date(createdAtMs).toISOString(),
			expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
		};
		this.#records.set(record.id, record);
		return structuredClone(record);
	}

	async send(
		handleOrId: string,
		message: string,
		callerSessionId: string,
	): Promise<string> {
		const backend = this.#requireOpenBackend();
		await this.sweepExpired();
		const record = this.#records.get(normalizeAgentId(handleOrId));
		if (!record)
			throw new RetainedAgentError(`Unknown retained agent ${handleOrId}`);
		this.#requireOwner(record, callerSessionId);
		if (record.state !== "active") {
			throw new RetainedAgentError(
				`Retained agent ${record.id} is ${record.state}`,
			);
		}
		if (message.trim().length === 0) {
			throw new RetainedAgentError("Retained-agent message must not be empty");
		}
		return backend.send(record.id, message);
	}

	async release(
		handleOrId: string,
		callerSessionId: string,
	): Promise<RetainedAgentRecord> {
		this.#requireOpenBackend();
		const id = normalizeAgentId(handleOrId);
		const record = this.#records.get(id);
		if (!record)
			throw new RetainedAgentError(`Unknown retained agent ${handleOrId}`);
		this.#requireOwner(record, callerSessionId);
		await this.#releaseRecord(record, "released");
		return structuredClone(record);
	}

	async cleanupOwner(ownerSessionId: string): Promise<number> {
		const active = [...this.#records.values()].filter(
			(record) =>
				record.ownerSessionId === ownerSessionId && record.state === "active",
		);
		await Promise.all(
			active.map((record) => this.#releaseRecord(record, "released")),
		);
		return active.length;
	}

	async sweepExpired(): Promise<number> {
		if (!this.backend) return 0;
		const now = this.#now();
		const expired = [...this.#records.values()].filter(
			(record) =>
				record.state === "active" && Date.parse(record.expiresAt) <= now,
		);
		await Promise.all(
			expired.map((record) => this.#releaseRecord(record, "expired")),
		);
		return expired.length;
	}

	list(callerSessionId: string): RetainedAgentRecord[] {
		return [...this.#records.values()]
			.filter((record) => record.ownerSessionId === callerSessionId)
			.map((record) => structuredClone(record));
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const active = [...this.#records.values()].filter(
			(record) => record.state === "active",
		);
		await Promise.all(
			active.map((record) => this.#releaseRecord(record, "released")),
		);
	}

	async #releaseRecord(
		record: RetainedAgentRecord,
		state: Exclude<RetainedAgentState, "active">,
	): Promise<void> {
		if (record.state !== "active") return;
		await this.backend?.release(record.id);
		record.state = state;
	}

	#requireOwner(
		record: RetainedAgentRecord,
		callerSessionId: string,
	): void {
		if (
			callerSessionId.trim().length === 0 ||
			record.ownerSessionId !== callerSessionId
		) {
			throw new RetainedAgentError(
				`Retained agent ${record.id} is owned by another session`,
			);
		}
	}

	#requireOpenBackend(): RetainedAgentBackend {
		if (this.#closed)
			throw new RetainedAgentError("Retained-agent adapter is closed");
		if (!this.backend) throw new RetainedAgentError(UNSUPPORTED_REASON);
		return this.backend;
	}
}

function normalizeAgentId(handleOrId: string): string {
	return handleOrId.startsWith("agent://")
		? handleOrId.slice("agent://".length)
		: handleOrId;
}
