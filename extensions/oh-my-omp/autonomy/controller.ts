import { isAbsolute } from "node:path";

import type { AutonomyStore } from "./store";
import type {
	AutonomyCompletionDecision,
	AutonomyGateRecord,
	AutonomyRun,
	AutonomyTerminalStatus,
	RecordAutonomyGateArgs,
	StartAutonomyArgs,
} from "./types";

const TERMINAL_STATUSES: Partial<Record<AutonomyRun["status"], true>> = {
	succeeded: true,
	failed: true,
	cancelled: true,
};

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class AutonomyTransitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutonomyTransitionError";
	}
}

export interface AutonomyControllerOptions {
	now?: () => string;
	createId?: () => string;
	isProcessAlive?: (pid: number) => boolean;
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

function terminalEligibilityError(
	state: AutonomyRun,
	status: AutonomyTerminalStatus,
): string | null {
	if (
		state.verificationLease !== undefined &&
		(status === "succeeded" || status === "failed")
	) {
		return "Cannot finalize autonomy while verification is running";
	}
	if (status === "succeeded" && !completionDecision(state).completed) {
		return "Cannot mark autonomy succeeded without current gate evidence";
	}
	if (
		status === "failed" &&
		(state.attempt < state.maxAttempts || completionDecision(state).completed)
	) {
		return "Cannot mark autonomy failed before its incomplete attempt bound";
	}
	return null;
}

export class AutonomyController {
	private readonly now: () => string;
	private readonly createId: () => string;
	private readonly isProcessAlive: (pid: number) => boolean;

	constructor(
		private readonly store: AutonomyStore,
		options: AutonomyControllerOptions = {},
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? (() => crypto.randomUUID());
		this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
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
		if (args.verificationCommand.trim().length === 0) {
			throw new AutonomyTransitionError(
				"Autonomy verification command must not be empty",
			);
		}
		if (
			args.ownerSessionFile.trim().length === 0 ||
			!isAbsolute(args.ownerSessionFile)
		) {
			throw new AutonomyTransitionError(
				"Autonomy requires an absolute persisted owner session file",
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
			ownerSessionFile: args.ownerSessionFile.trim(),
			artifactRevision: 0,
			gates: args.gates.map((gate) => ({
				...gate,
				status: "pending",
				attempt: 1,
				artifactRevision: 0,
			})),
			verificationLease: existing?.verificationLease,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.store.save(state, existing?.revision ?? 0);
		return state;
	}

	async bindNativeGoal(
		goal: {
			id: string;
			objective: string;
		},
		expectedRunId?: string,
	): Promise<AutonomyRun> {
		const state = await this.requireMutable(
			"bind a native goal",
			false,
			expectedRunId,
		);
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

	async recordGate(
		args: RecordAutonomyGateArgs,
		expectedRunId?: string,
	): Promise<AutonomyRun> {
		const evidence = args.evidence.trim();
		if (evidence.length === 0) {
			throw new AutonomyTransitionError("Gate evidence must not be empty");
		}
		const expectedId = expectedRunId ?? (await this.requireState()).id;
		return this.store.update(expectedId, (state) => {
			this.assertMutableState(state, "record gate evidence", false, expectedId);
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
			const gateIndex = state.gates.findIndex(
				(gate) => gate.id === args.gateId,
			);
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
			const gates = state.gates.map(
				(gate, index): AutonomyGateRecord =>
					index !== gateIndex
						? gate
						: {
								...gate,
								status: args.status,
								evidence,
								reporter: args.reporter,
								attempt: args.attempt,
								artifactRevision: args.artifactRevision,
								updatedAt: timestamp,
							},
			);
			return {
				...state,
				status: "running",
				revision: state.revision + 1,
				gates,
				updatedAt: timestamp,
			};
		});
	}

	async beginVerification(
		expectedRunId: string,
		expected: { attempt: number; artifactRevision: number },
		token: string,
	): Promise<AutonomyRun> {
		const normalizedToken = token.trim();
		if (normalizedToken.length === 0) {
			throw new AutonomyTransitionError("Verification token must not be empty");
		}
		return this.store.update(expectedRunId, (state) => {
			this.assertMutableState(
				state,
				"begin verification",
				false,
				expectedRunId,
			);
			const orphanedLease =
				state.verificationLease !== undefined &&
				!this.isProcessAlive(state.verificationLease.ownerPid);
			if (state.verificationLease !== undefined && !orphanedLease) {
				throw new AutonomyTransitionError(
					"Another autonomy verification is already running",
				);
			}
			if (
				state.attempt !== expected.attempt ||
				state.artifactRevision !== expected.artifactRevision
			) {
				throw new AutonomyTransitionError(
					`Cannot begin verification: expected attempt ${expected.attempt} artifact revision ${expected.artifactRevision}, found attempt ${state.attempt} artifact revision ${state.artifactRevision}`,
				);
			}
			const gateIndex = state.gates.findIndex(
				(gate) => gate.id === "verification",
			);
			if (gateIndex < 0) {
				throw new AutonomyTransitionError(
					"Autonomy verification gate is not configured",
				);
			}
			const timestamp = this.now();
			const artifactRevision = orphanedLease
				? state.artifactRevision + 1
				: state.artifactRevision;
			return {
				...state,
				revision: state.revision + 1,
				artifactRevision,
				artifactHash: orphanedLease
					? `orphaned-verification:${state.verificationLease?.token}`
					: state.artifactHash,
				verificationLease: {
					token: normalizedToken,
					ownerPid: process.pid,
					startedAt: timestamp,
				},
				gates: state.gates.map((gate, index) =>
					orphanedLease || index === gateIndex
						? resetGate(gate, state.attempt, artifactRevision)
						: gate,
				),
				updatedAt: timestamp,
			};
		});
	}

	async clearCurrentVerification(token: string): Promise<AutonomyRun> {
		return this.store.updateCurrent((state) => {
			if (state.verificationLease?.token !== token) {
				throw new AutonomyTransitionError(
					"Verification lease changed before it could be cleared",
				);
			}
			return {
				...state,
				revision: state.revision + 1,
				verificationLease: undefined,
				updatedAt: this.now(),
			};
		});
	}

	async recordArtifactRevision(
		artifactHash: string,
		expectedRunId?: string,
		expected?: { attempt: number; artifactRevision: number },
	): Promise<AutonomyRun> {
		const normalizedHash = artifactHash.trim();
		if (normalizedHash.length === 0) {
			throw new AutonomyTransitionError("Artifact hash must not be empty");
		}
		const expectedId = expectedRunId ?? (await this.requireState()).id;
		return this.store.update(expectedId, (state) => {
			this.assertMutableState(
				state,
				"record an artifact revision",
				false,
				expectedId,
			);
			if (
				expected !== undefined &&
				(state.attempt !== expected.attempt ||
					state.artifactRevision !== expected.artifactRevision)
			) {
				throw new AutonomyTransitionError(
					`Cannot record an artifact revision: expected attempt ${expected.attempt} artifact revision ${expected.artifactRevision}, found attempt ${state.attempt} artifact revision ${state.artifactRevision}`,
				);
			}
			const timestamp = this.now();
			const artifactRevision = state.artifactRevision + 1;
			return {
				...state,
				status: state.status === "paused" ? "paused" : "running",
				revision: state.revision + 1,
				artifactRevision,
				artifactHash: normalizedHash,
				gates: state.gates.map((gate) =>
					resetGate(gate, state.attempt, artifactRevision),
				),
				updatedAt: timestamp,
			};
		});
	}
	async recordCurrentArtifactRevision(
		artifactHash: string,
		verificationToken?: string,
	): Promise<AutonomyRun> {
		const normalizedHash = artifactHash.trim();
		if (normalizedHash.length === 0) {
			throw new AutonomyTransitionError("Artifact hash must not be empty");
		}
		return this.store.updateCurrent((state) => {
			if (
				verificationToken !== undefined &&
				state.verificationLease?.token !== verificationToken
			) {
				throw new AutonomyTransitionError(
					"Verification lease changed before artifact invalidation",
				);
			}
			if (state.status !== "cancelled" || verificationToken === undefined) {
				this.assertMutableState(
					state,
					"record an artifact revision",
					verificationToken !== undefined,
					state.id,
				);
			}
			const timestamp = this.now();
			const artifactRevision = state.artifactRevision + 1;
			return {
				...state,
				status:
					state.status === "paused" || state.status === "cancelled"
						? state.status
						: "running",
				revision: state.revision + 1,
				artifactRevision,
				artifactHash: normalizedHash,
				terminalIntent:
					verificationToken === undefined ? state.terminalIntent : undefined,
				verificationLease:
					state.verificationLease?.token === verificationToken
						? undefined
						: state.verificationLease,
				gates: state.gates.map((gate) =>
					resetGate(gate, state.attempt, artifactRevision),
				),
				updatedAt: timestamp,
			};
		});
	}

	async assessCompletion(
		expectedRunId?: string,
	): Promise<AutonomyCompletionDecision> {
		return completionDecision(
			await this.requireMutable("assess completion", false, expectedRunId),
		);
	}

	async markSucceeded(expectedRunId?: string): Promise<AutonomyRun> {
		const state = await this.requireMutable(
			"mark completion",
			false,
			expectedRunId,
		);
		const error = terminalEligibilityError(state, "succeeded");
		if (error !== null) {
			throw new AutonomyTransitionError(error);
		}
		return this.persist({
			...state,
			status: "succeeded",
			updatedAt: this.now(),
		});
	}

	async assessContinuation(
		expectedRunId?: string,
	): Promise<AutonomyCompletionDecision> {
		const state = await this.requireMutable(
			"assess continuation",
			false,
			expectedRunId,
		);
		return {
			completed: false,
			failed: state.attempt >= state.maxAttempts,
			pendingGateIds: state.gates
				.filter((gate) => gate.status !== "pass")
				.map((gate) => gate.id),
		};
	}

	async markFailedAtAttemptBound(expectedRunId?: string): Promise<AutonomyRun> {
		const state = await this.requireMutable(
			"mark attempt-bound failure",
			false,
			expectedRunId,
		);
		const error = terminalEligibilityError(state, "failed");
		if (error !== null) {
			throw new AutonomyTransitionError(error);
		}
		return this.persist({
			...state,
			status: "failed",
			lastError: `Maximum attempts reached (${state.maxAttempts})`,
			updatedAt: this.now(),
		});
	}

	async requestTerminalIntent(
		status: AutonomyTerminalStatus,
		commandId: string,
		expectedRunId?: string,
	): Promise<AutonomyRun> {
		const state = await this.requireMutable(
			"request a terminal transition",
			true,
			expectedRunId,
		);
		if (commandId.trim().length === 0) {
			throw new AutonomyTransitionError(
				"Terminal transition command ID must not be empty",
			);
		}
		const normalizedCommandId = commandId.trim();
		if (state.terminalIntent !== undefined) {
			if (
				state.terminalIntent.commandId === normalizedCommandId &&
				state.terminalIntent.status === status
			) {
				return state;
			}
			throw new AutonomyTransitionError(
				`Terminal transition for command ${state.terminalIntent.commandId} is already pending`,
			);
		}
		const error = terminalEligibilityError(state, status);
		if (error !== null) throw new AutonomyTransitionError(error);
		return this.persist({
			...state,
			terminalIntent: {
				status,
				commandId: normalizedCommandId,
				requestedAt: this.now(),
			},
			updatedAt: this.now(),
		});
	}

	async finalizeTerminalIntent(
		commandId: string,
		expectedRunId?: string,
	): Promise<AutonomyRun> {
		const state = await this.requireMutable(
			"finalize a terminal transition",
			true,
			expectedRunId,
		);
		const intent = state.terminalIntent;
		if (intent === undefined || intent.commandId !== commandId) {
			throw new AutonomyTransitionError(
				"Terminal transition does not match the acknowledged command",
			);
		}
		const error = terminalEligibilityError(state, intent.status);
		if (error !== null) {
			return this.persist({
				...state,
				status: "waiting",
				terminalIntent: undefined,
				updatedAt: this.now(),
			});
		}
		return this.persist({
			...state,
			status: intent.status,
			terminalIntent: undefined,
			lastError:
				intent.status === "failed"
					? `Maximum attempts reached (${state.maxAttempts})`
					: state.lastError,
			updatedAt: this.now(),
		});
	}

	async failTerminalIntent(
		commandId: string,
		reason: string,
		expectedRunId?: string,
	): Promise<AutonomyRun> {
		const state = await this.requireMutable(
			"fail a terminal transition",
			true,
			expectedRunId,
		);
		if (
			state.terminalIntent === undefined ||
			state.terminalIntent.commandId !== commandId
		) {
			throw new AutonomyTransitionError(
				"Terminal transition does not match the failed command",
			);
		}
		return this.persist({
			...state,
			status: "failed",
			terminalIntent: undefined,
			lastError: reason,
			updatedAt: this.now(),
		});
	}

	async continueAfterIncomplete(
		expectedRunId?: string,
	): Promise<AutonomyCompletionDecision> {
		const state = await this.requireMutable(
			"continue an incomplete run",
			false,
			expectedRunId,
		);
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

	async pause(expectedRunId?: string): Promise<AutonomyRun> {
		const state = await this.requireMutable("pause", false, expectedRunId);
		if (state.status === "paused") return state;
		return this.persist({
			...state,
			status: "paused",
			updatedAt: this.now(),
		});
	}

	async pauseWithError(
		reason: string,
		expectedRunId?: string,
	): Promise<AutonomyRun> {
		const state = await this.requireMutable(
			"pause after bootstrap failure",
			false,
			expectedRunId,
		);
		if (reason.trim().length === 0) {
			throw new AutonomyTransitionError(
				"Autonomy pause failure reason must not be empty",
			);
		}
		return this.persist({
			...state,
			status: "paused",
			lastError: reason.trim(),
			updatedAt: this.now(),
		});
	}

	async resume(): Promise<AutonomyRun> {
		const state = await this.requireState();
		if (state.status !== "paused") {
			throw new AutonomyTransitionError(
				`Cannot resume autonomy from ${state.status}`,
			);
		}
		return this.persist({
			...state,
			status: "running",
			lastError: undefined,
			updatedAt: this.now(),
		});
	}

	async cancel(expectedRunId?: string): Promise<AutonomyRun> {
		const state = await this.requireMutable("cancel", false, expectedRunId);
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

	private async requireMutable(
		action: string,
		allowTerminalIntent = false,
		expectedRunId?: string,
	): Promise<AutonomyRun> {
		const state = await this.requireState();
		this.assertMutableState(state, action, allowTerminalIntent, expectedRunId);
		return state;
	}

	private assertMutableState(
		state: AutonomyRun,
		action: string,
		allowTerminalIntent: boolean,
		expectedRunId?: string,
	): void {
		if (expectedRunId !== undefined && state.id !== expectedRunId) {
			throw new AutonomyTransitionError(
				`Cannot ${action}: autonomy run changed from ${expectedRunId} to ${state.id}`,
			);
		}
		if (TERMINAL_STATUSES[state.status] === true) {
			throw new AutonomyTransitionError(
				`Cannot ${action}: autonomy run is ${state.status}`,
			);
		}
		if (state.terminalIntent !== undefined && !allowTerminalIntent) {
			throw new AutonomyTransitionError(
				`Cannot ${action}: terminal transition for command ${state.terminalIntent.commandId} is pending`,
			);
		}
	}
	private async persist(state: AutonomyRun): Promise<AutonomyRun> {
		const next = { ...state, revision: state.revision + 1 };
		await this.store.save(next, state.revision);
		return next;
	}
}
