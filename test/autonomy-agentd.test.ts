import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
	AutonomyAgentd,
	type BrokerClient,
} from "../extensions/oh-my-omp/autonomy/agentd";
import {
	CommandJournal,
	CommandJournalError,
	type WorkerCommand,
} from "../extensions/oh-my-omp/autonomy/journal";
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
		cwd: "/tmp/project",
		sessionFile: "/tmp/session.jsonl",
		prompt: "Continue the verified goal.",
		createdAt: "2026-08-11T12:00:00.000Z",
	};
}

async function createJournal() {
	const root = await mkdtemp(join(tmpdir(), "pantheon-agentd-"));
	roots.push(root);
	let now = Date.parse("2026-08-11T12:00:00.000Z");
	return {
		root,
		journal: new CommandJournal(root, { now: () => now }),
		setNow(value: string) {
			now = Date.parse(value);
		},
	};
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
				const raw = await readFile(
					join(root, ".pi", "autonomy", "commands.jsonl"),
					"utf8",
				);
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
			status: "queued",
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

		await agentd.start();
		expect(await agentd.status()).toEqual({
			state: "ready",
			pid: 42,
			restartCount: 0,
		});
		await agentd.stop();
		expect(operations).toEqual([
			expect.objectContaining({
				op: "start",
				spec: expect.objectContaining({
					name: "pantheon-agentd",
					restart: "on-failure",
					persist: true,
					ready: expect.objectContaining({ log: "pantheon-agentd ready" }),
				}),
			}),
			{ op: "describe", name: "pantheon-agentd" },
			{ op: "stop", name: "pantheon-agentd", timeoutMs: 5_000 },
		]);
	});
});
