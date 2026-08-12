import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
	AutonomyAgentd,
	type BrokerClient,
	reconcileResidentTerminal,
} from "../extensions/oh-my-omp/autonomy/agentd";
import { AutonomyController } from "../extensions/oh-my-omp/autonomy/controller";
import {
	CommandJournal,
	CommandJournalError,
	type WorkerCommand,
} from "../extensions/oh-my-omp/autonomy/journal";
import { AutonomyStore } from "../extensions/oh-my-omp/autonomy/store";
import {
	AutonomyWorker,
	type CommandExecutor,
	OmpSessionExecutor,
} from "../extensions/oh-my-omp/autonomy/worker";

const roots: string[] = [];

function command(id = "command-1"): WorkerCommand {
	return {
		schemaVersion: 1,
		id,
		runId: "run-1",
		cwd: "/tmp/project",
		sessionFile: "/tmp/session.jsonl",
		prompt: "Continue the verified goal.",
		maxAttempts: 3,
		createdAt: "2026-08-11T12:00:00.000Z",
	};
}

async function createJournal() {
	const root = await mkdtemp(join(tmpdir(), "pantheon-agentd-"));
	roots.push(root);
	let now = Date.parse("2026-08-11T12:00:00.000Z");
	return {
		root,
		journal: new CommandJournal(root, {
			now: () => now,
			expectedRunId: "run-1",
			expectedCwd: "/tmp/project",
		}),
		setNow(value: string) {
			now = Date.parse(value);
		},
	};
}

async function createPendingTerminalIntent(commandId = "command-1") {
	const root = await mkdtemp(join(tmpdir(), "pantheon-terminal-intent-"));
	roots.push(root);
	const store = new AutonomyStore(root);
	const controller = new AutonomyController(store, {
		createId: () => "run-1",
		now: () => "2026-08-11T12:00:00.000Z",
	});
	await controller.start({
		task: "Finish durably",
		maxAttempts: 1,
		verificationCommand: "true",
		gates: [
			{
				id: "verification",
				label: "Targeted verification",
				requirement: { kind: "command" },
			},
		],
	});
	await controller.recordGate({
		gateId: "verification",
		status: "pass",
		evidence: "exit:0",
		reporter: "host-verifier",
		attempt: 1,
		artifactRevision: 0,
	});
	await controller.requestTerminalIntent("succeeded", commandId);
	return { controller, store };
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("CommandJournal", () => {
	test("deduplicates identical command IDs and rejects conflicting payloads", async () => {
		const { journal } = await createJournal();
		const first = await journal.enqueue(command());
		const duplicate = await journal.enqueue(command());

		expect(duplicate).toEqual(first);
		expect(await journal.list()).toHaveLength(1);
		await expect(
			journal.enqueue({ ...command(), prompt: "Different work" }),
		).rejects.toThrow("different payload");
	});

	test("uses leases and fencing tokens for expired-worker takeover", async () => {
		const { journal, setNow } = await createJournal();
		await journal.enqueue(command());
		const first = await journal.claimNext("worker-a", 1_000);
		expect(first).toMatchObject({ workerId: "worker-a", fencingToken: 1 });
		expect(await journal.claimNext("worker-b", 1_000)).toBeNull();

		setNow("2026-08-11T12:00:02.000Z");
		const takeover = await journal.claimNext("worker-b", 1_000);
		expect(takeover).toMatchObject({ workerId: "worker-b", fencingToken: 2 });
		await expect(
			journal.acknowledge("command-1", "worker-a", 1, {
				sessionId: "session-1",
				persistedAt: "2026-08-11T12:00:02.000Z",
			}),
		).rejects.toBeInstanceOf(CommandJournalError);
		const acknowledged = await journal.acknowledge("command-1", "worker-b", 2, {
			sessionId: "session-1",
			persistedAt: "2026-08-11T12:00:02.000Z",
		});
		expect(acknowledged.status).toBe("acknowledged");
	});

	test("rejects commands outside the bound run and project", async () => {
		const { journal } = await createJournal();

		await expect(
			journal.enqueue({ ...command(), runId: "other-run" }),
		).rejects.toThrow("invalid shape");
		await expect(
			journal.enqueue({ ...command(), cwd: "/tmp/other-project" }),
		).rejects.toThrow("invalid shape");
	});
});

describe("AutonomyWorker", () => {
	test("journals a claim before execution and acknowledges after persistence", async () => {
		const { journal, root } = await createJournal();
		await journal.enqueue(command());
		const observed: string[] = [];
		const executor: CommandExecutor = {
			async execute() {
				const [record] = await journal.list();
				observed.push(record?.status ?? "missing");
				const raw = await readFile(join(root, "commands.jsonl"), "utf8");
				expect(raw).toContain('"type":"claimed"');
				return {
					sessionId: "session-1",
					persistedAt: "2026-08-11T12:00:00.500Z",
				};
			},
			async close() {
				observed.push("closed");
			},
		};
		const worker = new AutonomyWorker(journal, executor, {
			workerId: "worker-a",
			leaseMs: 5_000,
		});

		expect(await worker.runOnce()).toBe(true);
		expect(observed).toEqual(["claimed"]);
		expect((await journal.list())[0]?.status).toBe("acknowledged");
		await worker.close();
		expect(observed).toEqual(["claimed", "closed"]);
	});

	test("exits before another claim when worker ownership changes", async () => {
		const { journal } = await createJournal();
		const stateRoot = await mkdtemp(join(tmpdir(), "pantheon-owner-state-"));
		roots.push(stateRoot);
		const store = new AutonomyStore(stateRoot);
		const owner = new AutonomyController(store, {
			createId: () => "run-1",
		});
		await owner.start({
			task: "Original run",
			maxAttempts: 1,
			verificationCommand: "true",
			gates: [
				{
					id: "verification",
					label: "Verification",
					requirement: { kind: "command" },
				},
			],
		});
		await journal.enqueue(command("command-1"));
		await journal.enqueue(command("command-2"));
		let executions = 0;
		const worker = new AutonomyWorker(
			journal,
			{
				async execute() {
					executions += 1;
					await owner.cancel();
					await new AutonomyController(store, {
						createId: () => "run-2",
					}).start({
						task: "Replacement run",
						maxAttempts: 1,
						verificationCommand: "true",
						gates: [
							{
								id: "verification",
								label: "Verification",
								requirement: { kind: "command" },
							},
						],
					});
					return {
						sessionId: `session-${executions}`,
						persistedAt: "2026-08-11T12:00:00.500Z",
					};
				},
				async close() {},
			},
			{
				workerId: "worker-a",
				leaseMs: 5_000,
				shouldStop: () => reconcileResidentTerminal("run-1", store, journal),
			},
		);

		await worker.run(new AbortController().signal);

		expect(executions).toBe(1);
		expect((await journal.list()).map((record) => record.status)).toEqual([
			"acknowledged",
			"queued",
		]);
		expect((await store.load())?.id).toBe("run-2");
	});

	test("finalizes resident success only after journal acknowledgement", async () => {
		const { journal } = await createJournal();
		const { store } = await createPendingTerminalIntent();
		await journal.enqueue(command());
		const claim = await journal.claimNext("worker-a", 5_000);
		if (claim === null) throw new Error("Expected command claim");

		expect(await reconcileResidentTerminal("run-1", store, journal)).toBe(
			false,
		);
		expect((await store.load())?.status).toBe("running");

		await journal.acknowledge(
			claim.command.id,
			"worker-a",
			claim.fencingToken,
			{
				sessionId: "session-1",
				persistedAt: "2026-08-11T12:00:00.500Z",
			},
		);
		expect(await reconcileResidentTerminal("run-1", store, journal)).toBe(true);
		expect((await store.load())?.status).toBe("succeeded");
	});

	test("fails a pending terminal transition when persistence is uncertain", async () => {
		const { journal } = await createJournal();
		const { store } = await createPendingTerminalIntent();
		await journal.enqueue(command());
		const claim = await journal.claimNext("worker-a", 5_000);
		if (claim === null) throw new Error("Expected command claim");
		await journal.markUncertain(
			claim.command.id,
			"worker-a",
			claim.fencingToken,
			"flush failed",
		);

		expect(await reconcileResidentTerminal("run-1", store, journal)).toBe(true);
		expect(await store.load()).toMatchObject({
			status: "failed",
			lastError: "Terminal transition persistence is uncertain: flush failed",
		});
	});

	test("does not acknowledge execution without a persistence receipt", async () => {
		const { journal } = await createJournal();
		await journal.enqueue(command());
		const executor = {
			execute: async () => ({ sessionId: "session-1", persistedAt: "" }),
			close: async () => {},
		};
		const worker = new AutonomyWorker(journal, executor, {
			workerId: "worker-a",
			leaseMs: 5_000,
		});

		await expect(worker.runOnce()).rejects.toThrow("persistence receipt");
		expect((await journal.list())[0]).toMatchObject({
			status: "uncertain",
			lastError: "Executor returned an invalid persistence receipt",
		});
	});

	test("aborts active execution and closes owned resources", async () => {
		const { journal } = await createJournal();
		await journal.enqueue(command());
		let closed = false;
		const entered = Promise.withResolvers<void>();
		const executor: CommandExecutor = {
			execute: (_command, signal) => {
				const pending = Promise.withResolvers<never>();
				signal.addEventListener(
					"abort",
					() => pending.reject(new Error("aborted")),
					{ once: true },
				);
				entered.resolve();
				return pending.promise;
			},
			async close() {
				closed = true;
			},
		};
		const worker = new AutonomyWorker(journal, executor, {
			workerId: "worker-a",
			leaseMs: 5_000,
		});
		const running = worker.runOnce();
		await entered.promise;

		await worker.close();
		await expect(running).rejects.toThrow("aborted");
		expect(closed).toBe(true);
	});

	test("renews leases while execution is active", async () => {
		const root = await mkdtemp(join(tmpdir(), "pantheon-agentd-heartbeat-"));
		roots.push(root);
		const journal = new CommandJournal(root, {
			expectedRunId: "run-1",
			expectedCwd: "/tmp/project",
		});
		await journal.enqueue(command());
		const executor: CommandExecutor = {
			async execute() {
				await Bun.sleep(90);
				return {
					sessionId: "session-1",
					persistedAt: new Date().toISOString(),
				};
			},
			async close() {},
		};
		const worker = new AutonomyWorker(journal, executor, {
			workerId: "worker-a",
			leaseMs: 30,
		});
		const running = worker.runOnce();
		await Bun.sleep(60);

		expect(await journal.claimNext("worker-b", 30)).toBeNull();
		await running;
		expect((await journal.list())[0]?.status).toBe("acknowledged");
	});

	test("bounds retries and marks completed-but-unacknowledged work uncertain", async () => {
		const failedFixture = await createJournal();
		await failedFixture.journal.enqueue({
			...command("failed-command"),
			maxAttempts: 1,
		});
		const failingWorker = new AutonomyWorker(
			failedFixture.journal,
			{
				async execute() {
					throw new Error("boom");
				},
				async close() {},
			},
			{ workerId: "worker-a", leaseMs: 5_000 },
		);
		await expect(failingWorker.runOnce()).rejects.toThrow("boom");
		expect((await failedFixture.journal.list())[0]?.status).toBe("failed");
		expect(await failedFixture.journal.claimNext("worker-b", 5_000)).toBeNull();

		const uncertainFixture = await createJournal();
		await uncertainFixture.journal.enqueue(command("uncertain-command"));
		const uncertainWorker = new AutonomyWorker(
			uncertainFixture.journal,
			{
				async execute() {
					uncertainFixture.setNow("2026-08-11T12:01:00.000Z");
					return {
						sessionId: "session-1",
						persistedAt: "2026-08-11T12:01:00.000Z",
					};
				},
				async close() {},
			},
			{ workerId: "worker-a", leaseMs: 5_000 },
		);
		await expect(uncertainWorker.runOnce()).rejects.toThrow("Lease expired");
		expect((await uncertainFixture.journal.list())[0]?.status).toBe(
			"uncertain",
		);
	});
});

describe("OMP session and broker adapters", () => {
	test("resumes with the public SDK and flushes before returning", async () => {
		const calls: string[] = [];
		const executor = new OmpSessionExecutor({
			openSessionManager: async (sessionFile) => {
				calls.push(`open:${sessionFile}`);
				return { sessionFile };
			},
			createSession: async ({ cwd, sessionManager }) => ({
				sessionId: "session-1",
				sessionFile: sessionManager.sessionFile,
				async prompt(prompt) {
					calls.push(`prompt:${cwd}:${prompt}`);
				},
				async waitForIdle() {
					calls.push("idle");
				},
				async flush() {
					calls.push("flush");
				},
				async dispose() {
					calls.push("dispose");
				},
			}),
			now: () => "2026-08-11T12:00:01.000Z",
		});

		const receipt = await executor.execute(
			command(),
			new AbortController().signal,
		);
		expect(receipt).toEqual({
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			persistedAt: "2026-08-11T12:00:01.000Z",
		});
		expect(calls).toEqual([
			"open:/tmp/session.jsonl",
			"prompt:/tmp/project:Continue the verified goal.",
			"idle",
			"flush",
			"dispose",
		]);
	});

	test("launches through the OMP broker and exposes status and stop", async () => {
		const operations: unknown[] = [];
		const broker: BrokerClient = {
			async request(operation) {
				operations.push(operation);
				if (operation.op === "describe") {
					return {
						op: "describe",
						daemon: { state: "ready", pid: 42, restartCount: 0 },
					};
				}
				return { op: operation.op };
			},
			close() {},
		};
		const agentd = new AutonomyAgentd("/tmp/project", {
			broker,
			entrypoint: "/tmp/agentd.ts",
			executable: "/usr/bin/bun",
		});

		await agentd.start("run-1");
		expect(await agentd.status("run-1")).toEqual({
			state: "ready",
			pid: 42,
			restartCount: 0,
		});
		await agentd.stop("run-1");
		const start = operations[0] as {
			spec: { name: string; args: string[] };
		};
		expect(start).toEqual(
			expect.objectContaining({
				op: "start",
				spec: expect.objectContaining({
					name: expect.stringMatching(/^pantheon-agentd-/),
					restart: "on-failure",
					persist: true,
					ready: expect.objectContaining({ log: "pantheon-agentd ready" }),
				}),
			}),
		);
		expect(start.spec.args).toEqual(
			expect.arrayContaining(["--run-id", "run-1", "--state-root"]),
		);
		expect(operations.slice(1)).toEqual([
			{ op: "describe", name: start.spec.name },
			{ op: "stop", name: start.spec.name, timeoutMs: 5_000 },
		]);
	});
});
