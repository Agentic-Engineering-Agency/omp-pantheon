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
	type AutonomyControllerOptions,
	AutonomyTransitionError,
} from "../extensions/oh-my-omp/autonomy/controller";
import { AutonomyStore } from "../extensions/oh-my-omp/autonomy/store";
import type { AutonomyRun } from "../extensions/oh-my-omp/autonomy/types";

const roots: string[] = [];

async function createHarness(options: AutonomyControllerOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "pantheon-autonomy-"));
	roots.push(root);
	let timestamp = Date.parse("2026-08-11T12:00:00.000Z");
	const store = new AutonomyStore(root);
	const controller = new AutonomyController(store, {
		now: () => new Date(timestamp++).toISOString(),
		createId: () => "run-1",
		...options,
	});
	return { controller, root, store };
}

async function startRun(controller: AutonomyController, maxAttempts = 3) {
	return controller.start({
		task: "Ship verified autonomy",
		maxAttempts,
		verificationCommand: "bun test",
		ownerSessionFile: "/tmp/pantheon-owner.jsonl",
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
				ownerSessionFile: "/tmp/pantheon-owner.jsonl",
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

	test("rejects relative owner session files", async () => {
		const { controller } = await createHarness();

		await expect(
			controller.start({
				task: "Ship verified autonomy",
				maxAttempts: 1,
				verificationCommand: "bun test",
				ownerSessionFile: "session.jsonl",
				gates: [
					{
						id: "verification",
						label: "Targeted verification",
						requirement: { kind: "command" },
					},
				],
			}),
		).rejects.toThrow("absolute persisted owner session");
	});

	test("never treats model completion text as completion evidence", async () => {
		const { controller } = await createHarness();
		const started = await startRun(controller);

		const decision = await controller.assessCompletion(started.id);

		expect(decision).toEqual({
			completed: false,
			failed: false,
			pendingGateIds: ["native-goal", "verification"],
		});
		expect((await controller.get())?.status).toBe("running");
	});

	test("rejects gate evidence while paused", async () => {
		const { controller } = await createHarness();
		const started = await startRun(controller);
		await controller.pause();

		await expect(
			controller.recordGate({
				gateId: "verification",
				status: "pass",
				evidence: "command:bun-test:exit-0",
				reporter: "host-verifier",
				attempt: started.attempt,
				artifactRevision: started.artifactRevision,
			}),
		).rejects.toThrow("paused");
		expect((await controller.get())?.status).toBe("paused");
	});

	test("scopes external pause and cancellation to the expected run", async () => {
		const { controller, store } = await createHarness();
		const original = await startRun(controller);
		await controller.cancel();
		const replacementController = new AutonomyController(store, {
			createId: () => "run-2",
		});
		await startRun(replacementController);

		await expect(controller.pause(original.id)).rejects.toThrow(
			"autonomy run changed",
		);
		await expect(controller.cancel(original.id)).rejects.toThrow(
			"autonomy run changed",
		);
		expect(await store.load()).toMatchObject({
			id: "run-2",
			status: "running",
		});
	});

	test("scopes direct terminalization to the expected run", async () => {
		const { controller, store } = await createHarness();
		const original = await startRun(controller, 1);
		await controller.cancel();
		const replacementController = new AutonomyController(store, {
			createId: () => "run-2",
		});
		await startRun(replacementController, 1);

		await expect(controller.markSucceeded(original.id)).rejects.toThrow(
			"autonomy run changed",
		);
		await expect(
			controller.markFailedAtAttemptBound(original.id),
		).rejects.toThrow("autonomy run changed");
		expect(await store.load()).toMatchObject({
			id: "run-2",
			status: "running",
		});
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

		expect(await controller.assessCompletion("run-1")).toMatchObject({
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

		expect(await controller.assessCompletion("run-1")).toEqual({
			completed: true,
			failed: false,
			pendingGateIds: [],
		});
		await controller.markSucceeded();
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
		await controller.markFailedAtAttemptBound();
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
		await controller.markSucceeded();
		const replacement = new AutonomyController(store, {
			now: () => "2026-08-11T13:00:00.000Z",
			createId: () => "run-2",
		});

		const started = await replacement.start({
			task: "Ship the next verified goal",
			maxAttempts: 2,
			verificationCommand: "bun test",
			ownerSessionFile: "/tmp/pantheon-owner-2.jsonl",
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

	test("only terminal reconciliation may clear a pending intent", async () => {
		const { controller } = await createHarness();
		await startRun(controller, 1);
		await controller.requestTerminalIntent("cancelled", "command-pending");

		for (const mutation of [
			() => controller.pause(),
			() => controller.cancel(),
			() => controller.markSucceeded(),
			() => controller.markFailedAtAttemptBound(),
		]) {
			await expect(mutation()).rejects.toThrow("terminal transition");
		}
		expect((await controller.get())?.terminalIntent).toMatchObject({
			status: "cancelled",
			commandId: "command-pending",
		});

		expect(
			(await controller.finalizeTerminalIntent("command-pending")).status,
		).toBe("cancelled");
	});
	test("fences terminal success while verification is running", async () => {
		const { controller } = await createHarness();
		const started = await startRun(controller);
		await controller.bindNativeGoal(
			{ id: "goal-verification-fence", objective: started.task },
			started.id,
		);
		for (const gate of (await controller.get())?.gates ?? []) {
			await controller.recordGate({
				gateId: gate.id,
				status: "pass",
				evidence: `before-verification:${gate.id}`,
				reporter:
					gate.id === "native-goal" ? "native-goal-event" : "host-verifier",
				attempt: 1,
				artifactRevision: 0,
			});
		}
		await controller.beginVerification(
			started.id,
			{ attempt: 1, artifactRevision: 0 },
			"verification-token",
		);

		await expect(
			controller.requestTerminalIntent("succeeded", "command-success"),
		).rejects.toThrow("verification is running");
		await controller.recordCurrentArtifactRevision(
			"late-verifier-mutation",
			"verification-token",
		);
		const current = await controller.get();
		expect(current?.verificationLease).toBeUndefined();
		expect(current?.terminalIntent).toBeUndefined();
		expect(current?.artifactRevision).toBe(1);
		expect(current?.gates.every((gate) => gate.status === "pending")).toBe(
			true,
		);
	});

	test("reclaims an orphaned verification lease and invalidates evidence", async () => {
		const { controller } = await createHarness({
			isProcessAlive: () => false,
		});
		const started = await startRun(controller);
		await controller.beginVerification(
			started.id,
			{ attempt: 1, artifactRevision: 0 },
			"orphaned-token",
		);

		const reclaimed = await controller.beginVerification(
			started.id,
			{ attempt: 1, artifactRevision: 0 },
			"replacement-token",
		);

		expect(reclaimed.artifactRevision).toBe(1);
		expect(reclaimed.artifactHash).toBe("orphaned-verification:orphaned-token");
		expect(reclaimed.verificationLease).toMatchObject({
			token: "replacement-token",
			ownerPid: process.pid,
		});
		expect(reclaimed.gates.every((gate) => gate.status === "pending")).toBe(
			true,
		);
		await expect(
			controller.recordCurrentArtifactRevision(
				"stale-orphaned-result",
				"orphaned-token",
			),
		).rejects.toThrow("lease changed");
	});

	test("refreshes cross-process finalization before starting the next run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pantheon-autonomy-refresh-"));
		roots.push(root);
		const store = new AutonomyStore(root);
		const ids = ["run-1", "run-2"];
		const ui = new AutonomyController(store, {
			createId: () => ids.shift() ?? "unexpected-run",
		});
		await ui.start({
			task: "First cross-process run",
			maxAttempts: 1,
			verificationCommand: "true",
			ownerSessionFile: "/tmp/pantheon-owner-1.jsonl",
			gates: [
				{
					id: "verification",
					label: "Targeted verification",
					requirement: { kind: "command" },
				},
			],
		});
		await ui.recordGate({
			gateId: "verification",
			status: "pass",
			evidence: "exit:0",
			reporter: "host-verifier",
			attempt: 1,
			artifactRevision: 0,
		});
		expect((await ui.get())?.status).toBe("running");

		const resident = new AutonomyController(store);
		await resident.requestTerminalIntent("succeeded", "command-1");
		await resident.finalizeTerminalIntent("command-1");

		expect((await ui.get())?.status).toBe("succeeded");
		const next = await ui.start({
			task: "Second cross-process run",
			maxAttempts: 1,
			verificationCommand: "true",
			ownerSessionFile: "/tmp/pantheon-owner-2.jsonl",
			gates: [
				{
					id: "verification",
					label: "Targeted verification",
					requirement: { kind: "command" },
				},
			],
		});
		expect(next).toMatchObject({ id: "run-2", status: "running" });
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

	test("rejects persisted relative owner session files", async () => {
		const { controller, store } = await createHarness();
		const started = await startRun(controller);

		await expect(
			store.save({ ...started, ownerSessionFile: "session.jsonl" }, 1),
		).rejects.toThrow("invalid shape");
	});

	test("rejects malformed resident terminal intents", async () => {
		const { controller, store } = await createHarness();
		const started = await startRun(controller);
		const forged: AutonomyRun = {
			...started,
			revision: 2,
			terminalIntent: null as unknown as AutonomyRun["terminalIntent"],
			updatedAt: "2026-08-11T12:00:01.000Z",
		};

		await expect(store.save(forged, 1)).rejects.toThrow("invalid shape");
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

	test("atomically preserves artifact invalidation after a concurrent gate write", async () => {
		const { controller, root, store } = await createHarness();
		const started = await startRun(controller);
		await controller.bindNativeGoal({
			id: "goal-1",
			objective: started.task,
		});
		const staleController = new AutonomyController(new AutonomyStore(root));
		const beforeGate = await controller.get();
		if (beforeGate === null) throw new Error("run missing");
		await controller.recordGate({
			gateId: "native-goal",
			status: "pass",
			evidence: "goal:goal-1:complete",
			reporter: "native-goal-event",
			attempt: beforeGate.attempt,
			artifactRevision: beforeGate.artifactRevision,
		});

		const revised = await staleController.recordArtifactRevision(
			"tool:write:sha256",
			started.id,
		);

		expect(revised.artifactRevision).toBe(1);
		expect(revised.gates.every((gate) => gate.status === "pending")).toBe(true);
		expect((await store.load())?.revision).toBe(revised.revision);
	});
	test("atomically merges concurrent evidence for distinct gates", async () => {
		const { controller, root, store } = await createHarness();
		const started = await startRun(controller);
		await controller.bindNativeGoal({
			id: "goal-1",
			objective: started.task,
		});
		const peer = new AutonomyController(new AutonomyStore(root));
		const current = await controller.get();
		if (current === null) throw new Error("run missing");

		await Promise.all([
			controller.recordGate({
				gateId: "native-goal",
				status: "pass",
				evidence: "goal:goal-1:complete",
				reporter: "native-goal-event",
				attempt: current.attempt,
				artifactRevision: current.artifactRevision,
			}),
			peer.recordGate({
				gateId: "verification",
				status: "pass",
				evidence: "command:bun test:exit:0",
				reporter: "host-verifier",
				attempt: current.attempt,
				artifactRevision: current.artifactRevision,
			}),
		]);

		const merged = await store.load();
		expect(merged?.gates).toEqual([
			expect.objectContaining({
				id: "native-goal",
				status: "pass",
				evidence: "goal:goal-1:complete",
			}),
			expect.objectContaining({
				id: "verification",
				status: "pass",
				evidence: "command:bun test:exit:0",
			}),
		]);
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
