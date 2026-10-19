#!/usr/bin/env -S bun run
/**
 * specsafe — slice lifecycle CLI.
 *
 * SpecSafe slice: SPEC-20260427-009 — omp-slice-lifecycle
 *
 * Mutates `.pi/.specsafe-state.json` to begin/end/inspect SpecSafe slices.
 * State-file shape is bit-identical to .pi/extensions/specsafe-session/index.ts;
 * types are imported from .omp/hooks/specsafe-session so any drift is caught
 * by the type checker.
 *
 * Usage:
 *   bun run .omp/skills/specsafe/bin/specsafe.ts begin <slice-id> <workspace-id> <session-id>
 *   bun run .omp/skills/specsafe/bin/specsafe.ts end <PASS|FAIL|ABANDONED>
 *   bun run .omp/skills/specsafe/bin/specsafe.ts status
 *
 * Exit codes:
 *   0  success
 *   1  lifecycle violation (begin while open, end while closed)
 *   2  usage error (missing/unknown args)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type CostCounter,
	type CurrentSlice,
	type HistoryEntry,
	type StateFile,
	readStateFileOrNull,
	statePathFor,
} from "../../../hooks/specsafe-session";

const USAGE = [
	"usage:",
	"  specsafe begin <slice-id> <workspace-id> <session-id>",
	"  specsafe end <PASS|FAIL|ABANDONED>",
	"  specsafe status",
].join("\n");

function freshCostCounter(): CostCounter {
	return {
		externalMemoryCalls: 0,
		externalMemoryCost: 0,
		subagentTokens: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		},
	};
}

function loadState(filePath: string): StateFile {
	return readStateFileOrNull(filePath) ?? { currentSlice: null, history: [] };
}

function atomicWrite(target: string, state: StateFile): void {
	const dir = path.dirname(target);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	const json = `${JSON.stringify(state, null, 2)}\n`;
	fs.writeFileSync(tmp, json, { mode: 0o600 });
	fs.renameSync(tmp, target);
	fs.chmodSync(target, 0o600);
}

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function cmdBegin(args: string[], statePath: string): number {
	const [sliceId, workspaceId, sessionId] = args;
	if (!sliceId || !workspaceId || !sessionId) {
		fail(
			`error: begin requires <slice-id> <workspace-id> <session-id>\n${USAGE}`,
			2,
		);
	}

	const state = loadState(statePath);
	if (state.currentSlice) {
		fail(
			`error: slice already open (${state.currentSlice.id}); end it before beginning a new one`,
			1,
		);
	}

	const slice: CurrentSlice = {
		id: sliceId,
		workspaceId,
		sessionId,
		beganAt: new Date().toISOString(),
		costCounter: freshCostCounter(),
	};
	const next: StateFile = { currentSlice: slice, history: state.history };
	atomicWrite(statePath, next);
	process.stdout.write(`OPEN: ${slice.id}\n`);
	return 0;
}

function cmdEnd(args: string[], statePath: string): number {
	const [outcomeRaw] = args;
	if (!outcomeRaw) {
		fail(`error: end requires <PASS|FAIL|ABANDONED>\n${USAGE}`, 2);
	}
	if (
		outcomeRaw !== "PASS" &&
		outcomeRaw !== "FAIL" &&
		outcomeRaw !== "ABANDONED"
	) {
		fail(
			`error: outcome must be one of PASS|FAIL|ABANDONED (got: ${outcomeRaw})\n${USAGE}`,
			2,
		);
	}
	const outcome = outcomeRaw as HistoryEntry["outcome"];

	const state = loadState(statePath);
	if (!state.currentSlice) {
		fail("error: no slice open; run `specsafe begin` first", 1);
	}

	const slice = state.currentSlice;
	const entry: HistoryEntry = {
		sliceId: slice.id,
		workspaceId: slice.workspaceId,
		sessionId: slice.sessionId,
		beganAt: slice.beganAt,
		endedAt: new Date().toISOString(),
		outcome,
		costSummary: {
			...slice.costCounter,
			subagentTokens: { ...slice.costCounter.subagentTokens },
		},
	};
	const next: StateFile = {
		currentSlice: null,
		history: [...state.history, entry],
	};
	atomicWrite(statePath, next);
	process.stdout.write(`CLOSED: ${slice.id} ${outcome}\n`);
	return 0;
}

function cmdStatus(statePath: string): number {
	const state = loadState(statePath);
	const lines: string[] = [];
	if (state.currentSlice) {
		lines.push(`OPEN: ${state.currentSlice.id}`);
	} else {
		lines.push("no slice open");
	}
	lines.push(`${state.history.length} history entries`);
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

function main(argv: string[]): number {
	const [sub, ...rest] = argv;
	if (!sub) {
		fail(`error: missing subcommand\n${USAGE}`, 2);
	}

	const cwd = process.cwd();
	const statePath = statePathFor(cwd);

	switch (sub) {
		case "begin":
			return cmdBegin(rest, statePath);
		case "end":
			return cmdEnd(rest, statePath);
		case "status":
			return cmdStatus(statePath);
		default:
			fail(`error: unknown subcommand: ${sub}\n${USAGE}`, 2);
	}
}

process.exit(main(process.argv.slice(2)));
