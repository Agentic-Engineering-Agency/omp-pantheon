import type { AutonomyStore } from "./store";
import type {
	AutonomyCompletionDecision,
	AutonomyGateRecord,
	AutonomyRun,
	RecordAutonomyGateArgs,
	StartAutonomyArgs,
} from "./types";

const TERMINAL_STATUSES: Partial<Record<AutonomyRun["status"], true>> = {
	succeeded: true,
	failed: true,
	cancelled: true,
};

export class AutonomyTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutonomyTransitionError";
	}
}

export interface AutonomyControllerOptions {
	now?: () => string;
	createId?: () => string;
}

export class AutonomyController {
	private readonly now: () => string;
	private readonly createId: () => string;

	constructor(
		private readonly store: AutonomyStore,
		options: AutonomyControllerOptions = {},
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? (() => crypto.randomUUID());
	}

	async get(): Promise<AutonomyRun | null> {
		return this.store.load();
	}

	async start(args: StartAutonomyArgs): Promise<AutonomyRun> {
		if (args.task.trim().length === 0) {
			throw new AutonomyTransitionError("Autonomy task must not be empty");
		}
		if (!Number.isInteger(args.maxAttempts) || args.maxAttempts < 1) {
			throw new AutonomyTransitionError(
				"Autonomy maxAttempts must be a positive integer",
			);
		}
		if (args.gates.length === 0) {
			throw new AutonomyTransitionError(
				"Autonomy requires at least one completion gate",
			);
		}
		const gateIds = new Set(args.gates.map((gate) => gate.id));
		if (
			gateIds.size !== args.gates.length ||
			args.gates.some(
				(gate) => gate.id.trim().length === 0 || gate.label.trim().length === 0,
			)
		) {
			throw new AutonomyTransitionError(
				"Autonomy gate IDs and labels must be non-empty and unique",
			);
		}

		const existing = await this.store.load();
		if (existing !== null && TERMINAL_STATUSES[existing.status] !== true) {
			throw new AutonomyTransitionError(
				`Autonomy run ${existing.id} is already ${existing.status}`,
			);
		}
		if (existing !== null) {
			throw new AutonomyTransitionError(
				"Starting a replacement run requires archiving the terminal journal",
			);
		}

		const timestamp = this.now();
		const state: AutonomyRun = {
			schemaVersion: 1,
			id: this.createId(),
			task: args.task.trim(),
			status: "running",
			revision: 1,
			attempt: 1,
			maxAttempts: args.maxAttempts,
			artifactRevision: 0,
			gates: args.gates.map((gate) => ({
				...gate,
				status: "pending",
				attempt: 1,
				artifactRevision: 0,
			})),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.store.save(state);
		return state;
	}

	async recordGate(args: RecordAutonomyGateArgs): Promise<AutonomyRun> {
		const state = await this.requireMutable("record gate evidence");
		if (args.attempt !== state.attempt) {
			throw new AutonomyTransitionError(
				`Gate evidence targets attempt ${args.attempt}, current attempt is ${state.attempt}`,
			);
		}
		if (args.artifactRevision !== state.artifactRevision) {
			throw new AutonomyTransitionError(
				`Gate evidence targets artifact revision ${args.artifactRevision}, current artifact revision is ${state.artifactRevision}`,
			);
		}
		if (args.evidence.trim().length === 0) {
			throw new AutonomyTransitionError("Gate evidence must not be empty");
		}
		const gateIndex = state.gates.findIndex((gate) => gate.id === args.gateId);
		if (gateIndex === -1) {
			throw new AutonomyTransitionError(
				`Unknown autonomy gate: ${args.gateId}`,
			);
		}

		const timestamp = this.now();
		const gates = state.gates.map((gate, index): AutonomyGateRecord => {
			if (index !== gateIndex) return gate;
			return {
				...gate,
				status: args.status,
				evidence: args.evidence.trim(),
				attempt: args.attempt,
				artifactRevision: args.artifactRevision,
				updatedAt: timestamp,
			};
		});
		return this.persist({
			...state,
			status: "running",
			gates,
			updatedAt: timestamp,
		});
	}

	async recordArtifactRevision(artifactHash: string): Promise<AutonomyRun> {
		const state = await this.requireMutable("record an artifact revision");
		if (artifactHash.trim().length === 0) {
			throw new AutonomyTransitionError("Artifact hash must not be empty");
		}
		const timestamp = this.now();
		const artifactRevision = state.artifactRevision + 1;
		return this.persist({
			...state,
			status: "running",
			artifactRevision,
			artifactHash: artifactHash.trim(),
			gates: state.gates.map((gate) => ({
				id: gate.id,
				label: gate.label,
				status: "pending",
				attempt: state.attempt,
				artifactRevision,
			})),
			updatedAt: timestamp,
		});
	}

	async evaluateCompletion(
		_agentCompletionText?: string,
	): Promise<AutonomyCompletionDecision> {
		const state = await this.requireMutable("evaluate completion");
		const pendingGateIds = state.gates
			.filter(
				(gate) =>
					gate.status !== "pass" ||
					gate.attempt !== state.attempt ||
					gate.artifactRevision !== state.artifactRevision,
			)
			.map((gate) => gate.id);
		const completed = pendingGateIds.length === 0;
		const timestamp = this.now();
		await this.persist({
			...state,
			status: completed ? "succeeded" : "waiting",
			updatedAt: timestamp,
		});
		return { completed, failed: false, pendingGateIds };
	}

	async continueAfterIncomplete(): Promise<AutonomyCompletionDecision> {
		const state = await this.requireMutable("continue an incomplete run");
		if (state.attempt >= state.maxAttempts) {
			await this.persist({
				...state,
				status: "failed",
				lastError: `Maximum attempts reached (${state.maxAttempts})`,
				updatedAt: this.now(),
			});
			return {
				completed: false,
				failed: true,
				pendingGateIds: state.gates
					.filter((gate) => gate.status !== "pass")
					.map((gate) => gate.id),
			};
		}

		const attempt = state.attempt + 1;
		const timestamp = this.now();
		const next = await this.persist({
			...state,
			status: "running",
			attempt,
			gates: state.gates.map((gate) => ({
				id: gate.id,
				label: gate.label,
				status: "pending",
				attempt,
				artifactRevision: state.artifactRevision,
			})),
			updatedAt: timestamp,
			lastError: undefined,
		});
		return {
			completed: false,
			failed: false,
			pendingGateIds: next.gates.map((gate) => gate.id),
		};
	}

	async pause(): Promise<AutonomyRun> {
		const state = await this.requireMutable("pause");
		if (state.status === "paused") return state;
		return this.persist({ ...state, status: "paused", updatedAt: this.now() });
	}

	async resume(): Promise<AutonomyRun> {
		const state = await this.requireState();
		if (state.status !== "paused") {
			throw new AutonomyTransitionError(
				`Cannot resume autonomy from ${state.status}`,
			);
		}
		return this.persist({ ...state, status: "running", updatedAt: this.now() });
	}

	async cancel(): Promise<AutonomyRun> {
		const state = await this.requireMutable("cancel");
		return this.persist({
			...state,
			status: "cancelled",
			updatedAt: this.now(),
		});
	}

	private async requireState(): Promise<AutonomyRun> {
		const state = await this.store.load();
		if (state === null) {
			throw new AutonomyTransitionError("No autonomy run exists");
		}
		return state;
	}

	private async requireMutable(action: string): Promise<AutonomyRun> {
		const state = await this.requireState();
		if (TERMINAL_STATUSES[state.status] === true) {
			throw new AutonomyTransitionError(
				`Cannot ${action}: autonomy run is ${state.status}`,
			);
		}
		return state;
	}

	private async persist(state: AutonomyRun): Promise<AutonomyRun> {
		const next = { ...state, revision: state.revision + 1 };
		await this.store.save(next);
		return next;
	}
}
