import { describe, expect, test } from "bun:test";

import {
	RetainedAgentAdapter,
	type RetainedAgentBackend,
	RetainedAgentError,
} from "../extensions/oh-my-omp/autonomy/retained-agents";

function backend() {
	const calls: string[] = [];
	let nextId = 0;
	const implementation: RetainedAgentBackend = {
		async retain(prompt, ownerSessionId) {
			const id = `agent-${++nextId}`;
			calls.push(`retain:${id}:${ownerSessionId}:${prompt}`);
			return { id, handle: `agent://${id}` };
		},
		async send(agentId, message) {
			calls.push(`send:${agentId}:${message}`);
			return `reply:${message}`;
		},
		async release(agentId) {
			calls.push(`release:${agentId}`);
		},
	};
	return { calls, implementation };
}

describe("RetainedAgentAdapter", () => {
	test("reports eval.agent retention unsupported on OMP 17 by default", async () => {
		const adapter = new RetainedAgentAdapter();

		expect(adapter.capability()).toEqual({
			supported: false,
			reason:
				"OMP 17.2.14 eval.agent hard-codes one-shot disposal and exposes no keep-alive option",
		});
		await expect(
			adapter.retain("work", "session-owner", 1_000),
		).rejects.toBeInstanceOf(RetainedAgentError);
	});

	test("retains addressable agents with bounded TTL and owner", async () => {
		const { implementation } = backend();
		let now = Date.parse("2026-08-11T12:00:00.000Z");
		const adapter = new RetainedAgentAdapter(implementation, {
			now: () => now,
			maxTtlMs: 60_000,
		});

		const retained = await adapter.retain(
			"Investigate",
			"session-owner",
			5_000,
		);
		expect(retained).toEqual({
			id: "agent-1",
			handle: "agent://agent-1",
			ownerSessionId: "session-owner",
			state: "active",
			createdAt: "2026-08-11T12:00:00.000Z",
			expiresAt: "2026-08-11T12:00:05.000Z",
		});
		await expect(
			adapter.retain("Too long", "session-owner", 60_001),
		).rejects.toThrow("TTL");
		now += 1;
	});

	test("delivers messages to concurrent retained agents", async () => {
		const { calls, implementation } = backend();
		const adapter = new RetainedAgentAdapter(implementation);
		const first = await adapter.retain("First", "session-owner", 5_000);
		const second = await adapter.retain("Second", "session-owner", 5_000);

		expect(
			await adapter.send(first.handle, "continue", "session-owner"),
		).toBe("reply:continue");
		expect(await adapter.send(second.id, "status", "session-owner")).toBe(
			"reply:status",
		);
		expect(calls).toContain("send:agent-1:continue");
		expect(calls).toContain("send:agent-2:status");
	});

	test("expires agents and prevents later delivery", async () => {
		const { calls, implementation } = backend();
		let now = Date.parse("2026-08-11T12:00:00.000Z");
		const adapter = new RetainedAgentAdapter(implementation, {
			now: () => now,
		});
		const retained = await adapter.retain("First", "session-owner", 1_000);
		now += 1_001;

		expect(await adapter.sweepExpired()).toBe(1);
		await expect(
			adapter.send(retained.id, "late", "session-owner"),
		).rejects.toThrow("expired");
		expect(calls).toContain("release:agent-1");
	});

	test("cleans up one owner without releasing another owner's agents", async () => {
		const { calls, implementation } = backend();
		const adapter = new RetainedAgentAdapter(implementation);
		await adapter.retain("A1", "owner-a", 5_000);
		await adapter.retain("A2", "owner-a", 5_000);
		const other = await adapter.retain("B1", "owner-b", 5_000);

		expect(await adapter.cleanupOwner("owner-a")).toBe(2);
		expect(await adapter.send(other.id, "still alive", "owner-b")).toBe(
			"reply:still alive",
		);
		expect(calls.filter((call) => call.startsWith("release:"))).toEqual([
			"release:agent-1",
			"release:agent-2",
		]);
	});

	test("rejects cross-session send, release, and list access", async () => {
		const { implementation } = backend();
		const adapter = new RetainedAgentAdapter(implementation);
		const retained = await adapter.retain("Owned", "owner-a", 5_000);

		await expect(
			adapter.send(retained.id, "steal", "owner-b"),
		).rejects.toThrow("another session");
		await expect(
			adapter.release(retained.id, "owner-b"),
		).rejects.toThrow("another session");
		expect(adapter.list("owner-b")).toEqual([]);
		expect(adapter.list("owner-a")).toHaveLength(1);
	});

	test("releases every retained agent on shutdown", async () => {
		const { calls, implementation } = backend();
		const adapter = new RetainedAgentAdapter(implementation);
		await adapter.retain("A", "owner-a", 5_000);
		await adapter.retain("B", "owner-b", 5_000);

		await adapter.close();
		expect(calls.filter((call) => call.startsWith("release:"))).toEqual([
			"release:agent-1",
			"release:agent-2",
		]);
		await expect(adapter.retain("late", "owner", 5_000)).rejects.toThrow(
			"closed",
		);
	});
});
