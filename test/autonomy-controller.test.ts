import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
	AutonomyController,
	AutonomyTransitionError,
} from "../extensions/oh-my-omp/autonomy/controller";
import { AutonomyStore } from "../extensions/oh-my-omp/autonomy/store";

const roots: string[] = [];

async function createHarness() {
	const root = await mkdtemp(join(tmpdir(), "pantheon-autonomy-"));
	roots.push(root);
	let timestamp = Date.parse("2026-08-11T12:00:00.000Z");
	const store = new AutonomyStore(root);
	const controller = new AutonomyController(store, {
		now: () => new Date(timestamp++).toISOString(),
		createId: () => "run-1",
	});
	return { controller, root, store };
}

async function startRun(controller: AutonomyController, maxAttempts = 3) {
	return controller.start({
		task: "Ship verified autonomy",
		maxAttempts,
		gates: [
			{ id: "native-goal", label: "OMP native goal" },
			{ id: "verification", label: "Targeted verification" },
		],
	});
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("AutonomyController", () => {
	test("persists a new opt-in run and reloads it", async () => {
		const { controller, store } = await createHarness();
		const started = await startRun(controller);

		expect(started).toMatchObject({
			id: "run-1",
			status: "running",
			attempt: 1,
			artifactRevision: 0,
			maxAttempts: 3,
		});
		expect(started.gates.map((gate) => gate.status)).toEqual([
			"pending",
			"pending",
		]);
		expect(await store.load()).toEqual(started);
	});

	test("never treats model completion text as completion evidence", async () => {
		const { controller } = await createHarness();
		await startRun(controller);

		const decision = await controller.evaluateCompletion(
			"<promise>DONE</promise>",
		);

		expect(decision).toEqual({
			completed: false,
			failed: false,
			pendingGateIds: ["native-goal", "verification"],
		});
		expect((await controller.get())?.status).toBe("waiting");
	});

	test("requires every gate to pass for the current attempt and artifact", async () => {
		const { controller } = await createHarness();
		await startRun(controller);
		await controller.recordGate({
			gateId: "native-goal",
			status: "pass",
			evidence: "goal:goal-1:complete",
			attempt: 1,
			artifactRevision: 0,
		});

		expect(await controller.evaluateCompletion("done")).toMatchObject({
			completed: false,
			pendingGateIds: ["verification"],
		});

		await controller.recordGate({
			gateId: "verification",
			status: "pass",
			evidence: "command:bun-test:exit-0",
			attempt: 1,
			artifactRevision: 0,
		});

		expect(await controller.evaluateCompletion("ignored prose")).toEqual({
			completed: true,
			failed: false,
			pendingGateIds: [],
		});
		expect((await controller.get())?.status).toBe("succeeded");
	});

	test("invalidates stale evidence when artifacts change", async () => {
		const { controller } = await createHarness();
		await startRun(controller);
		for (const gateId of ["native-goal", "verification"]) {
			await controller.recordGate({
				gateId,
				status: "pass",
				evidence: `${gateId}:pass`,
				attempt: 1,
				artifactRevision: 0,
			});
		}

		const revised = await controller.recordArtifactRevision("sha256:new");

		expect(revised.artifactRevision).toBe(1);
		expect(revised.gates.map((gate) => gate.status)).toEqual([
			"pending",
			"pending",
		]);
		await expect(
			controller.recordGate({
				gateId: "verification",
				status: "pass",
				evidence: "stale",
				attempt: 1,
				artifactRevision: 0,
			}),
		).rejects.toThrow("artifact revision");
	});

	test("fails at the attempt bound and keeps terminal states immutable", async () => {
		const { controller } = await createHarness();
		await startRun(controller, 1);

		const decision = await controller.continueAfterIncomplete();

		expect(decision.failed).toBe(true);
		expect((await controller.get())?.status).toBe("failed");
		await expect(controller.resume()).rejects.toBeInstanceOf(
			AutonomyTransitionError,
		);
	});
});

describe("AutonomyStore", () => {
	test("recovers the newest journal state when the snapshot lags", async () => {
		const { controller, root, store } = await createHarness();
		const started = await startRun(controller);
		await controller.pause();
		await writeFile(
			join(root, ".pi", "autonomy", "state.json"),
			JSON.stringify(started),
		);

		expect((await store.load())?.status).toBe("paused");
	});

	test("rejects a corrupted journal instead of silently skipping it", async () => {
		const { controller, root, store } = await createHarness();
		await startRun(controller);
		const journalPath = join(root, ".pi", "autonomy", "events.jsonl");
		const journal = await readFile(journalPath, "utf8");
		await writeFile(
			journalPath,
			journal.replace('"sequence":1', '"sequence":2'),
		);

		await expect(store.load()).rejects.toThrow("journal");
	});
});
