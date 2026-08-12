import { createHash } from "node:crypto";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type KernelLanguage = "javascript" | "python" | "julia" | "ruby";

export interface KernelIdentity {
	id: string;
	language: KernelLanguage;
}

export interface KernelCheckpoint {
	schemaVersion: 1;
	sourceKernelId: string;
	language: KernelLanguage;
	createdAt: string;
	values: { [key: string]: JsonValue };
	byteLength: number;
	checksum: string;
}

export interface KernelCheckpointBackend {
	exportJsonState(kernelId: string): Promise<Record<string, unknown>>;
	createFreshKernel(language: KernelLanguage): Promise<KernelIdentity>;
	importJsonState(
		kernel: KernelIdentity,
		values: { [key: string]: JsonValue },
	): Promise<void>;
	replaceKernel(
		expectedCurrentKernelId: string,
		nextKernel: KernelIdentity,
	): Promise<void>;
	disposeKernel(kernel: KernelIdentity): Promise<void>;
}

interface CheckpointOptions {
	now?: () => string;
	maxBytes?: number;
}

export class CheckpointError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CheckpointError";
	}
}

const UNSUPPORTED_REASON =
	"OMP 17.2.14 does not expose public eval-kernel state export/import APIs";
const KERNEL_LANGUAGES: Readonly<Record<KernelLanguage, true>> = {
	javascript: true,
	python: true,
	julia: true,
	ruby: true,
};

export class KernelCheckpointAdapter {
	readonly #now: () => string;
	readonly #maxBytes: number;

	constructor(
		private readonly backend?: KernelCheckpointBackend,
		options: CheckpointOptions = {},
	) {
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#maxBytes = options.maxBytes ?? 1_048_576;
		if (!Number.isInteger(this.#maxBytes) || this.#maxBytes <= 0) {
			throw new CheckpointError("Checkpoint size limit must be positive");
		}
	}

	capability(): { supported: true } | { supported: false; reason: string } {
		return this.backend
			? { supported: true }
			: { supported: false, reason: UNSUPPORTED_REASON };
	}

	async capture(identity: KernelIdentity): Promise<KernelCheckpoint> {
		const backend = this.#requireBackend();
		this.#assertIdentity(identity);
		const values = assertJsonObject(await backend.exportJsonState(identity.id));
		const byteLength = Buffer.byteLength(JSON.stringify(values), "utf8");
		if (byteLength > this.#maxBytes) {
			throw new CheckpointError(
				`Checkpoint exceeds size limit of ${this.#maxBytes} bytes`,
			);
		}
		const withoutChecksum = {
			schemaVersion: 1 as const,
			sourceKernelId: identity.id,
			language: identity.language,
			createdAt: this.#now(),
			values,
			byteLength,
		};
		return {
			...withoutChecksum,
			checksum: checksum(withoutChecksum),
		};
	}

	async restore(
		checkpoint: KernelCheckpoint,
		expectedSourceKernelId: string,
	): Promise<KernelIdentity> {
		const backend = this.#requireBackend();
		this.#validateCheckpoint(checkpoint);
		if (checkpoint.sourceKernelId !== expectedSourceKernelId) {
			throw new CheckpointError(
				`Checkpoint belongs to foreign kernel ${checkpoint.sourceKernelId}`,
			);
		}
		const fresh = await backend.createFreshKernel(checkpoint.language);
		try {
			await backend.importJsonState(fresh, checkpoint.values);
			await backend.replaceKernel(expectedSourceKernelId, fresh);
			return fresh;
		} catch (error) {
			await backend.disposeKernel(fresh);
			throw error;
		}
	}

	#validateCheckpoint(checkpoint: KernelCheckpoint): void {
		if (checkpoint.schemaVersion !== 1) {
			throw new CheckpointError(
				`Unsupported checkpoint schema version ${String(checkpoint.schemaVersion)}`,
			);
		}
		this.#assertIdentity({
			id: checkpoint.sourceKernelId,
			language: checkpoint.language,
		});
		const values = assertJsonObject(checkpoint.values);
		const byteLength = Buffer.byteLength(JSON.stringify(values), "utf8");
		if (byteLength !== checkpoint.byteLength || byteLength > this.#maxBytes) {
			throw new CheckpointError("Checkpoint byte length is invalid");
		}
		const { checksum: observedChecksum, ...withoutChecksum } = checkpoint;
		if (checksum(withoutChecksum) !== observedChecksum) {
			throw new CheckpointError("Checkpoint checksum mismatch");
		}
	}

	#assertIdentity(identity: KernelIdentity): void {
		if (
			identity.id.trim().length === 0 ||
			KERNEL_LANGUAGES[identity.language] !== true
		) {
			throw new CheckpointError("Kernel identity is invalid");
		}
	}

	#requireBackend(): KernelCheckpointBackend {
		if (!this.backend) throw new CheckpointError(UNSUPPORTED_REASON);
		return this.backend;
	}
}

function checksum(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function assertJsonObject(value: unknown): { [key: string]: JsonValue } {
	const validated = assertJsonValue(value, new WeakSet<object>(), "state");
	if (
		validated === null ||
		Array.isArray(validated) ||
		typeof validated !== "object"
	) {
		throw new CheckpointError("Checkpoint state must be a JSON object");
	}
	return validated;
}

function assertJsonValue(
	value: unknown,
	ancestors: WeakSet<object>,
	path: string,
): JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new CheckpointError(
			`Checkpoint ${path} contains a non-finite number`,
		);
	}
	if (typeof value !== "object") {
		throw new CheckpointError(`Checkpoint ${path} contains a non-JSON value`);
	}
	if (ancestors.has(value)) {
		throw new CheckpointError(`Checkpoint ${path} contains a cyclic value`);
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry, index) =>
				assertJsonValue(entry, ancestors, `${path}[${index}]`),
			);
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new CheckpointError(
				`Checkpoint ${path} contains a non-plain object`,
			);
		}
		const result: { [key: string]: JsonValue } = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = assertJsonValue(entry, ancestors, `${path}.${key}`);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}
