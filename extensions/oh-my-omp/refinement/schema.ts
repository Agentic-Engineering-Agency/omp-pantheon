export type RefinementStatus =
	| "proposed"
	| "validated"
	| "approved"
	| "active"
	| "rejected"
	| "rolled_back"
	| "quarantined";

export interface RefinementProposal {
	schemaVersion: 1;
	id: string;
	artifactPath: string;
	baseHash: string;
	contentHash: string;
	author: string;
	source: string;
	parentId?: string;
	status: RefinementStatus;
	validationEvidence: string[];
	approvedBy?: string;
	reason?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateRefinementProposal {
	artifactPath: string;
	baseHash: string;
	contentHash: string;
	author: string;
	source: string;
	parentId?: string;
}

export interface RefinementLedgerEvent {
	schemaVersion: 1;
	sequence: number;
	at: string;
	proposal: RefinementProposal;
	checksum: string;
}
