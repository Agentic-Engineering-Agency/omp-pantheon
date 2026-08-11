import { describe, expect, test } from "bun:test";

import {
	CheckpointError,
	KernelCheckpointAdapter,
	type KernelCheckpointBackend,
} from "../extensions/oh-my-omp/autonomy/checkpoints";

function backend(overrides: Partial<KernelCheckpointBackend> = {}) {
	const calls: string[] = [];
	const implementation: KernelCheckpointBackend = {
		async exportJsonState(kernelId) {
			calls.push(`export:${kernelId}`);
			return { count: 2, nested: { ready: true }, items: ["a", null] };
		},
		async createFreshKernel(language) {
			calls.push(`create:${language}`);
			return { id: "kernel-fresh", language };
		},
		async importJsonState(kernel, values) {
			calls.push(`import:${kernel.id}:${JSON.stringify(values)}`);
		},
		async replaceKernel(expectedCurrentKernelId, nextKernel) {
			calls.push(`replace:${expectedCurrentKernelId}:${nextKernel.id}`);
		},
		async disposeKernel(kernel) {
			calls.push(`dispose:${kernel.id}`);
		},
		...overrides,
	};
	return { calls, implementation };
}

describe("KernelCheckpointAdapter", () => {
	test("reports OMP 17 kernel checkpoints as unsupported without a public backend", () => {
		const adapter = new KernelCheckpointAdapter();

		expect(adapter.capability()).toEqual({
			supported: false,
			reason:
				"OMP 17.2.14 does not expose public eval-kernel state export/import APIs",
		});
	});

	test("captures bounded JSON state with metadata and checksum", async () => {
		const { implementation } = backend();
		const adapter = new KernelCheckpointAdapter(implementation, {
			now: () => "2026-08-11T12:00:00.000Z",
			maxBytes: 4_096,
		});

		const checkpoint = await adapter.capture({
			id: "kernel-source",
			language: "python",
		});
		expect(checkpoint).toMatchObject({
			schemaVersion: 1,
			sourceKernelId: "kernel-source",
			language: "python",
			createdAt: "2026-08-11T12:00:00.000Z",
			values: { count: 2, nested: { ready: true }, items: ["a", null] },
		});
		expect(checkpoint.byteLength).toBeGreaterThan(0);
		expect(checkpoint.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	test("rejects executable, cyclic, binary, oversized, and unsupported state", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const value of [() => "code", cyclic, new Uint8Array([1, 2]), 10n]) {
			const { implementation } = backend({
				exportJsonState: async () => ({ unsafe: value }),
			});
			await expect(
				new KernelCheckpointAdapter(implementation).capture({
					id: "kernel-source",
					language: "javascript",
				}),
			).rejects.toBeInstanceOf(CheckpointError);
		}

		const { implementation } = backend({
			exportJsonState: async () => ({ huge: "x".repeat(200) }),
		});
		await expect(
			new KernelCheckpointAdapter(implementation, { maxBytes: 32 }).capture({
				id: "kernel-source",
				language: "javascript",
			}),
		).rejects.toThrow("size limit");
	});

	test("rejects tampering, foreign kernels, and unsupported schema versions", async () => {
		const { implementation } = backend();
		const adapter = new KernelCheckpointAdapter(implementation);
		const checkpoint = await adapter.capture({
			id: "kernel-source",
			language: "python",
		});

		await expect(
			adapter.restore(
				{ ...checkpoint, checksum: "sha256:tampered" },
				"kernel-source",
			),
		).rejects.toThrow("checksum");
		await expect(adapter.restore(checkpoint, "kernel-other")).rejects.toThrow(
			"foreign kernel",
		);
		await expect(
			adapter.restore(
				{ ...checkpoint, schemaVersion: 2 } as never,
				"kernel-source",
			),
		).rejects.toThrow("schema version");
	});

	test("imports into a fresh kernel before atomic replacement", async () => {
		const { calls, implementation } = backend();
		const adapter = new KernelCheckpointAdapter(implementation);
		const checkpoint = await adapter.capture({
			id: "kernel-source",
			language: "python",
		});
		calls.length = 0;

		await adapter.restore(checkpoint, "kernel-source");
		expect(calls).toEqual([
			"create:python",
			expect.stringContaining("import:kernel-fresh:"),
			"replace:kernel-source:kernel-fresh",
		]);
	});

	test("disposes a failed fresh restore without replacing the active kernel", async () => {
		const { calls, implementation } = backend({
			async importJsonState() {
				calls.push("import:failed");
				throw new Error("restore failed");
			},
		});
		const adapter = new KernelCheckpointAdapter(implementation);
		const checkpoint = await adapter.capture({
			id: "kernel-source",
			language: "ruby",
		});
		calls.length = 0;

		await expect(adapter.restore(checkpoint, "kernel-source")).rejects.toThrow(
			"restore failed",
		);
		expect(calls).toEqual([
			"create:ruby",
			"import:failed",
			"dispose:kernel-fresh",
		]);
	});
});
