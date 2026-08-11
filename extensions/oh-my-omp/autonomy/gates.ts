import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { readEvalFlyEnforcementState } from "../../../skills/evalfly/bin/enforcement-state";
import { evaluateEvalFlyCompletionGate } from "../evalfly/enforcement-gate";

import type {
	AutonomyGateDefinition,
	AutonomyGateRecord,
	AutonomyGateReporter,
	AutonomyRun,
} from "./types";

interface SpecSafeHistoryEntry {
	sliceId: string;
	outcome: "PASS" | "FAIL" | "ABANDONED";
	endedAt: string;
}

interface SpecSafeState {
	currentSlice: { id: string } | null;
	history: SpecSafeHistoryEntry[];
}

export interface HostGateReceipt {
	gateId: string;
	status: "pass" | "fail";
	evidence: string;
	reporter: Extract<
		AutonomyGateReporter,
		"evalfly-adapter" | "specsafe-adapter"
	>;
}

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function readSpecSafeState(cwd: string): SpecSafeState | null {
	const piPath = join(cwd, ".pi");
	if (!existsSync(piPath)) return null;
	const piMetadata = lstatSync(piPath);
	if (!piMetadata.isDirectory() || piMetadata.isSymbolicLink()) {
		throw new Error("unsafe SpecSafe state path");
	}
	const statePath = join(piPath, ".specsafe-state.json");
	if (!existsSync(statePath)) return null;
	const stateMetadata = lstatSync(statePath);
	if (
		!stateMetadata.isFile() ||
		stateMetadata.isSymbolicLink() ||
		realpathSync(statePath) !==
			resolve(realpathSync(cwd), ".pi", ".specsafe-state.json")
	) {
		throw new Error("unsafe SpecSafe state path");
	}
	const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("currentSlice" in parsed) ||
		!("history" in parsed) ||
		!Array.isArray(parsed.history)
	) {
		throw new Error("malformed SpecSafe state");
	}
	let currentSlice: SpecSafeState["currentSlice"];
	const rawCurrentSlice = parsed.currentSlice;
	if (rawCurrentSlice === null) {
		currentSlice = null;
	} else if (
		typeof rawCurrentSlice === "object" &&
		rawCurrentSlice !== null &&
		!Array.isArray(rawCurrentSlice) &&
		"id" in rawCurrentSlice
	) {
		currentSlice = {
			id: requireNonEmptyString(rawCurrentSlice.id, "SpecSafe slice id"),
		};
	} else {
		throw new Error("malformed SpecSafe current slice");
	}
	const history = parsed.history.map((entry): SpecSafeHistoryEntry => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			Array.isArray(entry) ||
			!("sliceId" in entry) ||
			!("outcome" in entry) ||
			!("endedAt" in entry)
		) {
			throw new Error("malformed SpecSafe history");
		}
		const outcome = entry.outcome;
		if (outcome !== "PASS" && outcome !== "FAIL" && outcome !== "ABANDONED") {
			throw new Error("malformed SpecSafe history outcome");
		}
		const endedAt = requireNonEmptyString(
			entry.endedAt,
			"SpecSafe history end time",
		);
		if (!Number.isFinite(Date.parse(endedAt))) {
			throw new Error("malformed SpecSafe history end time");
		}
		return {
			sliceId: requireNonEmptyString(
				entry.sliceId,
				"SpecSafe history slice id",
			),
			outcome,
			endedAt,
		};
	});
	const historyIds = new Set(history.map((entry) => entry.sliceId));
	if (
		historyIds.size !== history.length ||
		(currentSlice !== null && historyIds.has(currentSlice.id))
	) {
		throw new Error("malformed SpecSafe slice history");
	}
	return { currentSlice, history };
}

export function configuredAutonomyGates(cwd: string): AutonomyGateDefinition[] {
	const gates: AutonomyGateDefinition[] = [
		{
			id: "native-goal",
			label: "OMP native goal",
			requirement: { kind: "native-goal" },
		},
		{
			id: "verification",
			label: "Targeted test or smoke command",
			requirement: { kind: "command" },
		},
	];
	const evalFly = readEvalFlyEnforcementState(cwd);
	if (evalFly.mode === "enforced") {
		const activatedAt = requireNonEmptyString(
			evalFly.activatedAt,
			"EvalFly enforcement activation time",
		);
		if (!Number.isFinite(Date.parse(activatedAt))) {
			throw new Error("EvalFly enforcement activation time must be valid");
		}
		gates.push({
			id: "evalfly",
			label: "EvalFly enforcement",
			requirement: {
				kind: "evalfly",
				suite: evalFly.suite as "smoke" | "regression" | "benchmark",
				commitRange: requireNonEmptyString(
					evalFly.commitRange,
					"EvalFly commit range",
				),
				activatedAt,
			},
		});
	}
	const specSafe = readSpecSafeState(cwd);
	if (specSafe?.currentSlice !== null && specSafe?.currentSlice !== undefined) {
		gates.push({
			id: "specsafe",
			label: "SpecSafe slice closure",
			requirement: { kind: "specsafe", sliceId: specSafe.currentSlice.id },
		});
	}
	return gates;
}

function evaluateEvalFlyGate(
	cwd: string,
	gate: AutonomyGateRecord,
): HostGateReceipt {
	if (gate.requirement.kind !== "evalfly") {
		throw new Error("EvalFly gate has an invalid requirement");
	}
	try {
		const current = readEvalFlyEnforcementState(cwd);
		if (
			current.mode !== "enforced" ||
			current.suite !== gate.requirement.suite ||
			current.commitRange !== gate.requirement.commitRange ||
			current.activatedAt !== gate.requirement.activatedAt
		) {
			return {
				gateId: gate.id,
				status: "fail",
				evidence: "evalfly:configured-enforcement-changed-or-unavailable",
				reporter: "evalfly-adapter",
			};
		}
		const result = evaluateEvalFlyCompletionGate(cwd);
		return result.allowed
			? {
					gateId: gate.id,
					status: "pass",
					evidence: `evalfly:${gate.requirement.suite}:${gate.requirement.commitRange}:passing-after:${gate.requirement.activatedAt}`,
					reporter: "evalfly-adapter",
				}
			: {
					gateId: gate.id,
					status: "fail",
					evidence: `evalfly:${result.reason}`,
					reporter: "evalfly-adapter",
				};
	} catch (error) {
		return {
			gateId: gate.id,
			status: "fail",
			evidence: `evalfly:${error instanceof Error ? error.message : String(error)}`,
			reporter: "evalfly-adapter",
		};
	}
}

function evaluateSpecSafeGate(
	cwd: string,
	gate: AutonomyGateRecord,
): HostGateReceipt {
	if (gate.requirement.kind !== "specsafe") {
		throw new Error("SpecSafe gate has an invalid requirement");
	}
	const requirement = gate.requirement;
	try {
		const state = readSpecSafeState(cwd);
		const closure = state?.history.find(
			(entry) => entry.sliceId === requirement.sliceId,
		);
		if (closure?.outcome === "PASS") {
			return {
				gateId: gate.id,
				status: "pass",
				evidence: `specsafe:${closure.sliceId}:PASS:${closure.endedAt}`,
				reporter: "specsafe-adapter",
			};
		}
		return {
			gateId: gate.id,
			status: "fail",
			evidence:
				closure === undefined
					? `specsafe:${requirement.sliceId}:closure-unavailable`
					: `specsafe:${closure.sliceId}:${closure.outcome}:${closure.endedAt}`,
			reporter: "specsafe-adapter",
		};
	} catch (error) {
		return {
			gateId: gate.id,
			status: "fail",
			evidence: `specsafe:${error instanceof Error ? error.message : String(error)}`,
			reporter: "specsafe-adapter",
		};
	}
}

export function evaluateConfiguredHostGates(
	cwd: string,
	state: AutonomyRun,
): HostGateReceipt[] {
	const receipts: HostGateReceipt[] = [];
	for (const gate of state.gates) {
		if (gate.requirement.kind === "evalfly") {
			receipts.push(evaluateEvalFlyGate(cwd, gate));
		} else if (gate.requirement.kind === "specsafe") {
			receipts.push(evaluateSpecSafeGate(cwd, gate));
		}
	}
	return receipts;
}
