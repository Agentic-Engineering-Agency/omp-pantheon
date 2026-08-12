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

function resetGate(
	gate: AutonomyGateRecord,
	attempt: number,
	artifactRevision: number,
): AutonomyGateRecord {
	return {
		id: gate.id,
		label: gate.label,
		requirement: gate.requirement,
		status: "pending",
		attempt,
		artifactRevision,
	};
}

function hasValidGateRequirement(
	requirement: AutonomyGateRecord["requirement"],
): boolean {
	switch (requirement.kind) {
		case "native-goal":
		case "command":
			return true;
		case "evalfly":
			return (
				["smoke", "regression", "benchmark"].includes(requirement.suite) &&
				requirement.commitRange.trim().length > 0 &&
				Number.isFinite(Date.parse(requirement.activatedAt))
			);
		case "specsafe":
			return (
				requirement.sliceId.trim().length > 0 &&
				Number.isFinite(Date.parse(requirement.beganAt)) &&
				Number.isFinite(Date.parse(requirement.activatedAt))
			);
	}
}

function completionDecision(state: AutonomyRun): AutonomyCompletionDecision {
	const pendingGateIds = state.gates
		.filter(
			(gate) =>
				gate.status !== "pass" ||
				gate.attempt !== state.attempt ||
				gate.artifactRevision !== state.artifactRevision,
		)
		.map((gate) => gate.id);
	return {
		completed: pendingGateIds.length === 0,
		failed: false,
		pendingGateIds,
	};
}

export class AutonomyController {
	private readonly now: () => string;
	private readonly createId: () => string;
	private cachedState: AutonomyRun | null | undefined;

	constructor(
		private readonly store: AutonomyStore,
		options: AutonomyControllerOptions = {},
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? (() => crypto.randomUUID());
	}

	async get(): Promise<AutonomyRun | null> {
		if (this.cachedState === undefined) {
			this.cachedState = await this.store.load();
		}
		return this.cachedState;
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
		if (args.verificationCommand.trim().length === 0) {
			throw new AutonomyTransitionError(
				"Autonomy verification command must not be empty",
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
				(gate) =>
					gate.id.trim().length === 0 ||
					gate.label.trim().length === 0 ||
					!hasValidGateRequirement(gate.requirement),
			)
		) {
			throw new AutonomyTransitionError(
				"Autonomy gate IDs, labels, and requirements must be valid and unique",
			);
		}

		const existing = await this.get();
		if (existing !== null && TERMINAL_STATUSES[existing.status] !== true) {
			throw new AutonomyTransitionError(
				`Autonomy run ${existing.id} is already ${existing.status}`,
			);
		}

		const timestamp = this.now();
		const state: AutonomyRun = {
			schemaVersion: 1,
			id: this.createId(),
			task: args.task.trim(),
			status: "running",
			revision: (existing?.revision ?? 0) + 1,
			attempt: 1,
			maxAttempts: args.maxAttempts,
			verificationCommand: args.verificationCommand.trim(),
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
		await this.store.save(state, existing?.revision ?? 0);
		this.cachedState = state;
		return state;
	}

	async bindNativeGoal(goal: {
		id: string;
		objective: string;
	}): Promise<AutonomyRun> {
		const state = await this.requireMutable("bind a native goal");
		if (goal.id.trim().length === 0 || goal.objective.trim() !== state.task) {
			throw new AutonomyTransitionError(
				"Native goal must have an ID and exactly match the autonomy objective",
			);
		}
		if (state.nativeGoalId !== undefined) {
			if (state.nativeGoalId === goal.id) return state;
			throw new AutonomyTransitionError(
				`Autonomy run is already bound to native goal ${state.nativeGoalId}`,
			);
		}
		return this.persist({
			...state,
			nativeGoalId: goal.id,
			updatedAt: this.now(),
		});
	}

	async recordGate(args: RecordAutonomyGateArgs): Promise<AutonomyRun> {
		const state = await this.requireMutable("record gate evidence");
		if (state.status === "paused") {
			throw new AutonomyTransitionError(
				"Cannot record gate evidence while autonomy is paused",
			);
		}
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
		const requirement = state.gates[gateIndex]?.requirement;
		const expectedReporter =
			requirement?.kind === "native-goal"
				? "native-goal-event"
				: requirement?.kind === "evalfly"
					? "evalfly-adapter"
					: requirement?.kind === "specsafe"
						? "specsafe-adapter"
						: "host-verifier";
		if (args.reporter !== expectedReporter) {
			throw new AutonomyTransitionError(
				`Autonomy gate ${args.gateId} requires reporter ${expectedReporter}`,
			);
		}
		if (args.gateId === "native-goal" && state.nativeGoalId === undefined) {
			throw new AutonomyTransitionError(
				"Autonomy native goal gate is not bound to this run",
			);
		}

		const timestamp = this.now();
		const gates = state.gates.map((gate, index): AutonomyGateRecord => {
			if (index !== gateIndex) return gate;
			return {
				...gate,
				status: args.status,
				evidence: args.evidence.trim(),
				reporter: args.reporter,
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
			status: state.status === "paused" ? "paused" : "running",
			artifactRevision,
			artifactHash: artifactHash.trim(),
			gates: state.gates.map((gate) =>
				resetGate(gate, state.attempt, artifactRevision),
			),
			updatedAt: timestamp,
		});
	}

	async assessCompletion(): Promise<AutonomyCompletionDecision> {
		return completionDecision(await this.requireMutable("assess completion"));
	}

	async markSucceeded(): Promise<AutonomyRun> {
		const state = await this.requireMutable("mark completion");
		if (!completionDecision(state).completed) {
			throw new AutonomyTransitionError(
				"Cannot mark autonomy succeeded without current gate evidence",
			);
		}
		return this.persist({
			...state,
			status: "succeeded",
			updatedAt: this.now(),
		});
	}

	async assessContinuation(): Promise<AutonomyCompletionDecision> {
		const state = await this.requireMutable("assess continuation");
		return {
			completed: false,
			failed: state.attempt >= state.maxAttempts,
			pendingGateIds: state.gates
				.filter((gate) => gate.status !== "pass")
				.map((gate) => gate.id),
		};
	}

	async markFailedAtAttemptBound(): Promise<AutonomyRun> {
		const state = await this.requireMutable("mark attempt-bound failure");
		if (
			state.attempt < state.maxAttempts ||
			completionDecision(state).completed
		) {
			throw new AutonomyTransitionError(
				"Cannot mark autonomy failed before its incomplete attempt bound",
			);
		}
		return this.persist({
			...state,
			status: "failed",
			lastError: `Maximum attempts reached (${state.maxAttempts})`,
			updatedAt: this.now(),
		});
	}

	async evaluateCompletion(
		_agentCompletionText?: string,
	): Promise<AutonomyCompletionDecision> {
		const state = await this.requireMutable("evaluate completion");
		const decision = completionDecision(state);
		if (!decision.completed) {
			await this.persist({
				...state,
				status: "waiting",
				updatedAt: this.now(),
			});
		}
		return decision;
	}

	async continueAfterIncomplete(): Promise<AutonomyCompletionDecision> {
		const state = await this.requireMutable("continue an incomplete run");
		if (state.attempt >= state.maxAttempts) {
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
			gates: state.gates.map((gate) =>
				resetGate(gate, attempt, state.artifactRevision),
			),
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
		const state = await this.get();
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
		await this.store.save(next, state.revision);
		this.cachedState = next;
		return next;
	}
}
