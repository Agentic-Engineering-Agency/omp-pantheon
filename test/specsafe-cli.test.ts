import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type CostCounter,
	type StateFile,
	readStateFileOrNull,
	statePathFor,
} from "../hooks/specsafe-session";

const cliPath = path.resolve(process.cwd(), "skills/specsafe/bin/specsafe.ts");
const expectedZeroCostCounter: CostCounter = {
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

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "specsafe-cli-"));
	fs.mkdirSync(path.join(tempDir, ".pi"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function runCli(...args: string[]): SpawnSyncReturns<string> {
	return spawnSync("bun", ["run", cliPath, ...args], {
		cwd: tempDir,
		encoding: "utf-8",
	});
}

function readState(): StateFile | null {
	return readStateFileOrNull(statePathFor(tempDir));
}

function expectIsoString(value: unknown): asserts value is string {
	expect(typeof value).toBe("string");
	const text = String(value);
	expect(new Date(text).toISOString()).toBe(text);
}

function expectStateMode(expectedMode = 0o600): void {
	expect(fs.statSync(statePathFor(tempDir)).mode & 0o777).toBe(expectedMode);
}

function beginTestSlice(): SpawnSyncReturns<string> {
	return runCli("begin", "TEST-001", "ws-abc", "sess-123");
}

function expectBeginSucceeded(result: SpawnSyncReturns<string>): void {
	expect(result.status).toBe(0);
	expect(result.stderr).not.toContain("already open");
}

describe("[unit] specsafe CLI lifecycle", () => {
	test("C1 begin writes valid open-slice state with zeroed cost and empty history", () => {
		const result = beginTestSlice();

		expectBeginSucceeded(result);
		const state = readState();
		expect(state).not.toBeNull();
		expect(state?.history).toEqual([]);
		expect(state?.currentSlice).toMatchObject({
			id: "TEST-001",
			workspaceId: "ws-abc",
			sessionId: "sess-123",
			costCounter: expectedZeroCostCounter,
		});
		expectIsoString(state?.currentSlice?.beganAt);
	});

	test("C2 end PASS archives the open slice as history[0] and clears currentSlice", () => {
		const begin = beginTestSlice();
		expectBeginSucceeded(begin);
		const beganAt = readState()?.currentSlice?.beganAt;
		expectIsoString(beganAt);

		const end = runCli("end", "PASS");

		expect(end.status).toBe(0);
		expect(end.stderr).not.toContain("no slice open");
		const state = readState();
		expect(state?.currentSlice).toBeNull();
		expect(state?.history).toHaveLength(1);
		expect(state?.history[0]).toMatchObject({
			sliceId: "TEST-001",
			workspaceId: "ws-abc",
			sessionId: "sess-123",
			beganAt,
			outcome: "PASS",
			costSummary: expectedZeroCostCounter,
		});
		expectIsoString(state?.history[0]?.endedAt);
	});

	test("C3 status reports OPEN with the slice id and reports no slice open after close", () => {
		const begin = beginTestSlice();
		expectBeginSucceeded(begin);

		const openStatus = runCli("status");
		expect(openStatus.status).toBe(0);
		expect(openStatus.stdout).toContain("OPEN: TEST-001");

		const end = runCli("end", "PASS");
		expect(end.status).toBe(0);

		const closedStatus = runCli("status");
		expect(closedStatus.status).toBe(0);
		expect(closedStatus.stdout).toContain("no slice open");
	});

	test("C4 begin while another slice is already open exits 1 and explains already open", () => {
		const firstBegin = beginTestSlice();
		expectBeginSucceeded(firstBegin);

		const secondBegin = runCli("begin", "TEST-002", "ws-def", "sess-456");

		expect(secondBegin.status).toBe(1);
		expect(secondBegin.stderr).toContain("already open");
		const state = readState();
		expect(state?.currentSlice?.id).toBe("TEST-001");
		expect(state?.history).toEqual([]);
	});

	test("C5 end with no open slice exits 1 and explains no slice open", () => {
		const result = runCli("end", "PASS");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no slice open");
		expect(readState()).toBeNull();
	});

	test("C6 CLI-written state parses through readStateFileOrNull and matches the known-good begin snapshot", () => {
		const begin = beginTestSlice();
		expectBeginSucceeded(begin);

		const parsedByHook = readState();
		expect(parsedByHook).not.toBeNull();
		expectIsoString(parsedByHook?.currentSlice?.beganAt);
		const expected: StateFile = {
			currentSlice: {
				id: "TEST-001",
				workspaceId: "ws-abc",
				sessionId: "sess-123",
				beganAt: parsedByHook?.currentSlice?.beganAt as string,
				costCounter: expectedZeroCostCounter,
			},
			history: [],
		};
		expect(parsedByHook).toEqual(expected);

		const rawState = JSON.parse(
			fs.readFileSync(statePathFor(tempDir), "utf-8"),
		) as StateFile;
		expect(rawState).toEqual(parsedByHook);
	});

	test("C7 state file mode is 0600 after begin and remains 0600 after end", () => {
		const begin = beginTestSlice();
		expectBeginSucceeded(begin);
		expectStateMode(0o600);

		const end = runCli("end", "PASS");
		expect(end.status).toBe(0);
		expectStateMode(0o600);
	});

	test("C9 corrupt state is quarantined and begin treats it as empty state", () => {
		const statePath = statePathFor(tempDir);
		fs.writeFileSync(statePath, "{not valid json", { mode: 0o600 });

		const begin = beginTestSlice();

		expectBeginSucceeded(begin);
		expect(fs.existsSync(statePath)).toBe(true);
		const entries = fs.readdirSync(path.join(tempDir, ".pi"));
		expect(
			entries.some((entry) =>
				/^\.specsafe-state\.json\.corrupt-\d+$/.test(entry),
			),
		).toBe(true);
		const state = readState();
		expect(state?.currentSlice?.id).toBe("TEST-001");
		expect(state?.history).toEqual([]);
	});
});
