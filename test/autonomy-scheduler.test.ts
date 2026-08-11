import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
	CommandJournal,
	type WorkerCommand,
} from "../extensions/oh-my-omp/autonomy/journal";
import {
	PersistedScheduler,
	type ScheduleRequest,
	SchedulerError,
} from "../extensions/oh-my-omp/autonomy/scheduler";
import {
	AutonomyWorker,
	type CommandExecutor,
} from "../extensions/oh-my-omp/autonomy/worker";

const roots: string[] = [];

function command(id: string): WorkerCommand {
	return {
		schemaVersion: 1,
		id,
		cwd: "/tmp/project",
		sessionFile: "/tmp/session.jsonl",
		prompt: `Continue ${id}`,
		createdAt: "2026-08-11T12:00:00.000Z",
	};
}

function request(
	id: string,
	commandId: string,
	deadline = "2026-08-11T12:00:10.000Z",
): ScheduleRequest {
	return {
		schemaVersion: 1,
		id,
		coalesceKey: "goal-1:wakeup",
		command: command(commandId),
		deadline,
	};
}

async function fixture(
	options: { maxRetries?: number; baseRetryMs?: number } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pantheon-scheduler-"));
	roots.push(root);
	let now = Date.parse("2026-08-11T12:00:00.000Z");
	const clock = () => now;
	const journal = new CommandJournal(root, { now: clock });
	return {
		root,
		journal,
		scheduler: new PersistedScheduler(root, journal, {
			now: clock,
			maxRetries: options.maxRetries,
			baseRetryMs: options.baseRetryMs,
		}),
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

describe("PersistedScheduler", () => {
	test("orders absolute deadlines and tolerates wall-clock jumps", async () => {
		const { scheduler, setNow } = await fixture();
		await scheduler.schedule(
			request("late", "command-late", "2026-08-11T12:00:20.000Z"),
		);
		await scheduler.schedule(
			request("early", "command-early", "2026-08-11T12:00:10.000Z"),
		);

		setNow("2026-08-11T11:59:00.000Z");
		expect(await scheduler.claimDue("worker-a", 5_000)).toBeNull();
		setNow("2026-08-11T12:01:00.000Z");
		expect((await scheduler.claimDue("worker-a", 5_000))?.request.id).toBe(
			"early",
		);
	});

	test("recovers schedules and expired claims after restart", async () => {
		const { root, journal, scheduler, setNow } = await fixture();
		await scheduler.schedule(
			request("wake", "command-wake", "2026-08-11T12:00:00.000Z"),
		);
		const first = await scheduler.claimDue("worker-a", 1_000);
		expect(first).toMatchObject({ status: "claimed", fencingToken: 1 });

		setNow("2026-08-11T12:00:02.000Z");
		const restarted = new PersistedScheduler(root, journal, {
			now: () => Date.parse("2026-08-11T12:00:02.000Z"),
		});
		const takeover = await restarted.claimDue("worker-b", 1_000);
		expect(takeover).toMatchObject({
			status: "claimed",
			workerId: "worker-b",
			fencingToken: 2,
		});
		await expect(
			restarted.markDelivered("wake", "worker-a", 1),
		).rejects.toBeInstanceOf(SchedulerError);
	});

	test("claims a missed deadline before enqueueing and persists delivery", async () => {
		const { root, journal, scheduler, setNow } = await fixture();
		await scheduler.schedule(request("wake", "command-wake"));
		setNow("2026-08-11T13:00:00.000Z");

		const delivered = await scheduler.deliverDue("worker-a", 5_000);
		expect(delivered).toMatchObject({
			status: "delivered",
			workerId: "worker-a",
		});
		expect((await journal.list())[0]?.command.id).toBe("command-wake");
		const raw = await readFile(
			join(
				root,
				".pi",
				"autonomy",
				"scheduler",
				"generations",
				"1",
				"events.jsonl",
			),
			"utf8",
		);
		expect(raw.indexOf('"type":"claimed"')).toBeLessThan(
			raw.indexOf('"type":"delivered"'),
		);
	});
	test("feeds due schedules into the resident worker", async () => {
		const { journal, scheduler } = await fixture();
		await scheduler.schedule(
			request("wake", "command-wake", "2026-08-11T12:00:00.000Z"),
		);
		const executed: string[] = [];
		const executor: CommandExecutor = {
			async execute(work) {
				executed.push(work.id);
				return {
					sessionId: "session-1",
					persistedAt: "2026-08-11T12:00:01.000Z",
				};
			},
			async close() {},
		};
		const worker = new AutonomyWorker(
			journal,
			executor,
			{ workerId: "agentd-a", leaseMs: 5_000 },
			scheduler,
		);

		expect(await worker.runOnce()).toBe(true);
		expect(executed).toEqual(["command-wake"]);
		expect((await scheduler.list())[0]?.status).toBe("delivered");
		await worker.close();
	});

	test("coalesces equivalent wakeups but preserves distinct commands", async () => {
		const { scheduler } = await fixture();
		const first = await scheduler.schedule(request("wake-a", "command-a"));
		const equivalent = await scheduler.schedule(request("wake-b", "command-a"));
		await scheduler.schedule(request("wake-c", "command-c"));

		expect(equivalent.request.id).toBe(first.request.id);
		expect((await scheduler.list()).map((record) => record.request.id)).toEqual(
			["wake-a", "wake-c"],
		);
	});

	test("persists deterministic retries and fails with evidence at the bound", async () => {
		const firstFixture = await fixture({ maxRetries: 2, baseRetryMs: 1_000 });
		await firstFixture.scheduler.schedule(
			request("wake", "command-wake", "2026-08-11T12:00:00.000Z"),
		);
		const firstClaim = await firstFixture.scheduler.claimDue("worker-a", 5_000);
		expect(firstClaim).not.toBeNull();
		const retry = await firstFixture.scheduler.recordFailure(
			"wake",
			"worker-a",
			firstClaim?.fencingToken ?? 0,
			"temporary failure",
		);
		expect(retry).toMatchObject({
			status: "scheduled",
			retryCount: 1,
			lastError: "temporary failure",
			fencingToken: 1,
		});

		const secondFixture = await fixture({ maxRetries: 2, baseRetryMs: 1_000 });
		await secondFixture.scheduler.schedule(
			request("wake", "command-wake", "2026-08-11T12:00:00.000Z"),
		);
		const parallelClaim = await secondFixture.scheduler.claimDue(
			"worker-a",
			5_000,
		);
		const parallelRetry = await secondFixture.scheduler.recordFailure(
			"wake",
			"worker-a",
			parallelClaim?.fencingToken ?? 0,
			"temporary failure",
		);
		expect(parallelRetry.nextDeadline).toBe(retry.nextDeadline);

		firstFixture.setNow(retry.nextDeadline);
		const secondClaim = await firstFixture.scheduler.claimDue(
			"worker-b",
			5_000,
		);
		const failed = await firstFixture.scheduler.recordFailure(
			"wake",
			"worker-b",
			secondClaim?.fencingToken ?? 0,
			"permanent failure",
		);
		expect(failed).toMatchObject({
			status: "failed",
			retryCount: 2,
			lastError: "permanent failure",
			workerId: "worker-b",
			fencingToken: 2,
		});
		expect(await firstFixture.scheduler.claimDue("worker-c", 5_000)).toBeNull();
	});

	test("compacts into verified generations and keeps the prior generation", async () => {
		const { root, journal, scheduler } = await fixture();
		await scheduler.schedule(request("wake-a", "command-a"));
		await scheduler.compact();
		await scheduler.schedule(request("wake-b", "command-b"));
		await scheduler.compact();

		const manifest = JSON.parse(
			await readFile(
				join(root, ".pi", "autonomy", "scheduler", "manifest.json"),
				"utf8",
			),
		) as {
			schemaVersion: number;
			activeGeneration: number;
			previousGeneration: number;
		};
		expect(manifest).toEqual({
			schemaVersion: 1,
			activeGeneration: 3,
			previousGeneration: 2,
		});
		for (const generation of [2, 3]) {
			expect(
				await readFile(
					join(
						root,
						".pi",
						"autonomy",
						"scheduler",
						"generations",
						String(generation),
						"snapshot.json",
					),
					"utf8",
				),
			).toContain('"checksum"');
		}
		const restarted = new PersistedScheduler(root, journal);
		expect((await restarted.list()).map((record) => record.request.id)).toEqual(
			["wake-a", "wake-b"],
		);
	});
});
