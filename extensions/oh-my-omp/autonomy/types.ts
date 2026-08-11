export type AutonomyStatus =
	| "idle"
	| "running"
	| "waiting"
	| "paused"
	| "succeeded"
	| "failed"
	| "cancelled";

export type AutonomyGateStatus = "pending" | "pass" | "fail";

export interface AutonomyGateDefinition {
	id: string;
	label: string;
}

export interface AutonomyGateRecord extends AutonomyGateDefinition {
	status: AutonomyGateStatus;
	attempt: number;
	artifactRevision: number;
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
}

export interface RecordAutonomyGateArgs {
	gateId: string;
	status: Exclude<AutonomyGateStatus, "pending">;
	evidence: string;
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
