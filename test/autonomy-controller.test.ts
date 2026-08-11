import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
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
		verificationCommand: "bun test",
		gates: [
			{
				id: "native-goal",
				label: "OMP native goal",
				requirement: { kind: "native-goal" },
			},
			{
				id: "verification",
				label: "Targeted verification",
				requirement: { kind: "command" },
			},
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

	test("rejects malformed external gate requirements", async () => {
		const { controller } = await createHarness();

		await expect(
			controller.start({
				task: "Ship verified autonomy",
				maxAttempts: 3,
				verificationCommand: "bun test",
				gates: [
					{
						id: "evalfly",
						label: "EvalFly",
						requirement: {
							kind: "evalfly",
							suite: "smoke",
							commitRange: "",
							activatedAt: "not-a-date",
						},
					},
				],
			}),
		).rejects.toThrow("requirements");
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
		await controller.bindNativeGoal({
			id: "goal-1",
			objective: "Ship verified autonomy",
		});
		await controller.recordGate({
			gateId: "native-goal",
			status: "pass",
			evidence: "goal:goal-1:complete",
			reporter: "native-goal-event",
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
			reporter: "host-verifier",
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
		await controller.bindNativeGoal({
			id: "goal-1",
			objective: "Ship verified autonomy",
		});
		for (const gateId of ["native-goal", "verification"]) {
			await controller.recordGate({
				gateId,
				status: "pass",
				evidence: `${gateId}:pass`,
				reporter:
					gateId === "native-goal" ? "native-goal-event" : "host-verifier",
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
				reporter: "host-verifier",
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
	test("starts a fresh run after terminal completion without breaking journal continuity", async () => {
		const { controller, root, store } = await createHarness();
		await startRun(controller);
		await controller.bindNativeGoal({
			id: "goal-1",
			objective: "Ship verified autonomy",
		});
		for (const gateId of ["native-goal", "verification"]) {
			await controller.recordGate({
				gateId,
				status: "pass",
				evidence: `${gateId}:pass`,
				reporter:
					gateId === "native-goal" ? "native-goal-event" : "host-verifier",
				attempt: 1,
				artifactRevision: 0,
			});
		}
		await controller.evaluateCompletion();
		const replacement = new AutonomyController(store, {
			now: () => "2026-08-11T13:00:00.000Z",
			createId: () => "run-2",
		});

		const started = await replacement.start({
			task: "Ship the next verified goal",
			maxAttempts: 2,
			verificationCommand: "bun test",
			gates: [
				{
					id: "verification",
					label: "Targeted verification",
					requirement: { kind: "command" },
				},
			],
		});

		expect(started).toMatchObject({
			id: "run-2",
			status: "running",
			revision: 6,
		});
		const events = (
			await readFile(join(root, ".pi", "autonomy", "events.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as { sequence: number; state: { id: string } },
			);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(events.map((event) => event.state.id)).toEqual([
			"run-1",
			"run-1",
			"run-1",
			"run-1",
			"run-1",
			"run-2",
		]);
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

	test("rejects forged reporter evidence in a persisted gate", async () => {
		const { controller, store } = await createHarness();
		const started = await startRun(controller);
		const forged = {
			...started,
			revision: 2,
			gates: started.gates.map((gate, index) =>
				index === 0
					? {
							...gate,
							status: "pass" as const,
							reporter: "host-verifier" as const,
							evidence: "forged",
							updatedAt: "2026-08-11T12:00:01.000Z",
						}
					: gate,
			),
			updatedAt: "2026-08-11T12:00:01.000Z",
		};

		await expect(store.save(forged, 1)).rejects.toThrow("gate record");
	});

	test("rejects stale concurrent saves without corrupting journal continuity", async () => {
		const { controller, store } = await createHarness();
		const started = await startRun(controller);
		const paused = {
			...started,
			status: "paused" as const,
			revision: 2,
			updatedAt: "2026-08-11T12:00:01.000Z",
		};
		const cancelled = {
			...started,
			status: "cancelled" as const,
			revision: 2,
			updatedAt: "2026-08-11T12:00:02.000Z",
		};

		const results = await Promise.allSettled([
			store.save(paused, 1),
			store.save(cancelled, 1),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect((await store.load())?.revision).toBe(2);
	});
	test("refuses a symlinked project autonomy state directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pantheon-autonomy-symlink-"));
		const outside = await mkdtemp(join(tmpdir(), "pantheon-autonomy-outside-"));
		roots.push(root, outside);
		await mkdir(join(root, ".pi"));
		await symlink(outside, join(root, ".pi", "autonomy"), "dir");
		const store = new AutonomyStore(root);

		await expect(store.load()).rejects.toThrow("symbolic link");
		expect(await Bun.file(join(outside, "state.json")).exists()).toBe(false);
	});

	test("refuses symlinked project autonomy state files", async () => {
		const root = await mkdtemp(join(tmpdir(), "pantheon-autonomy-symlink-"));
		const outside = await mkdtemp(join(tmpdir(), "pantheon-autonomy-outside-"));
		roots.push(root, outside);
		await mkdir(join(root, ".pi", "autonomy"), { recursive: true });
		const outsideState = join(outside, "state.json");
		await writeFile(outsideState, "{}");
		await symlink(outsideState, join(root, ".pi", "autonomy", "state.json"));
		const store = new AutonomyStore(root);

		await expect(store.load()).rejects.toThrow("symbolic link");
	});
});
