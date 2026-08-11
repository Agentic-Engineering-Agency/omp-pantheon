export type AutonomyStatus =
	| "idle"
	| "running"
	| "waiting"
	| "paused"
	| "succeeded"
	| "failed"
	| "cancelled";

export type AutonomyGateStatus = "pending" | "pass" | "fail";
export type AutonomyGateReporter =
	| "native-goal-event"
	| "host-verifier"
	| "evalfly-adapter"
	| "specsafe-adapter";

export type AutonomyGateRequirement =
	| { kind: "native-goal" }
	| { kind: "command" }
	| {
			kind: "evalfly";
			suite: "smoke" | "regression" | "benchmark";
			commitRange: string;
			activatedAt: string;
	  }
	| { kind: "specsafe"; sliceId: string };

export interface AutonomyGateDefinition {
	id: string;
	label: string;
	requirement: AutonomyGateRequirement;
}

export interface AutonomyGateRecord extends AutonomyGateDefinition {
	status: AutonomyGateStatus;
	attempt: number;
	artifactRevision: number;
	reporter?: AutonomyGateReporter;
	evidence?: string;
	updatedAt?: string;
}

export interface AutonomyRun {
	schemaVersion: 1;
	id: string;
	task: string;
	status: Exclude<AutonomyStatus, "idle">;
	revision: number;
	attempt: number;
	maxAttempts: number;
	artifactRevision: number;
	verificationCommand: string;
	nativeGoalId?: string;
	artifactHash?: string;
	gates: AutonomyGateRecord[];
	createdAt: string;
	updatedAt: string;
	lastError?: string;
}

export interface StartAutonomyArgs {
	task: string;
	maxAttempts: number;
	gates: AutonomyGateDefinition[];
	verificationCommand: string;
}

export interface RecordAutonomyGateArgs {
	gateId: string;
	status: Exclude<AutonomyGateStatus, "pending">;
	evidence: string;
	reporter: AutonomyGateReporter;
	attempt: number;
	artifactRevision: number;
}

export interface AutonomyCompletionDecision {
	completed: boolean;
	failed: boolean;
	pendingGateIds: string[];
}

export interface AutonomyJournalEvent {
	schemaVersion: 1;
	sequence: number;
	at: string;
	state: AutonomyRun;
	checksum: string;
}
