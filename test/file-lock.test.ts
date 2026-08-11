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

import { acquireFileLock } from "../extensions/oh-my-omp/file-lock";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("acquireFileLock", () => {
	test("serializes concurrent reclaimers without stealing a replacement lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "pantheon-file-lock-"));
		roots.push(root);
		await mkdir(root, { recursive: true });
		const lockPath = join(root, "state.lock");
		await writeFile(
			lockPath,
			JSON.stringify({
				token: "dead-owner",
				pid: 2_147_483_647,
				acquiredAt: "2000-01-01T00:00:00.000Z",
			}),
		);
		await writeFile(`${lockPath}.breaker`, "orphaned");

		let active = 0;
		let maximumActive = 0;
		await Promise.all(
			Array.from({ length: 12 }, async () => {
				const release = await acquireFileLock(lockPath, {
					timeoutMs: 2_000,
					staleMs: 1,
					retryMs: 1,
				});
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Bun.sleep(2);
				active -= 1;
				await release();
			}),
		);

		expect(maximumActive).toBe(1);
		expect(await Bun.file(`${lockPath}.breaker`).exists()).toBe(false);
	});

	test("rejects a symbolic-link SQLite guard without touching its target", async () => {
		const root = await mkdtemp(join(tmpdir(), "pantheon-file-lock-"));
		roots.push(root);
		const lockPath = join(root, "state.lock");
		const outside = join(root, "outside.sqlite");
		await writeFile(outside, "sentinel");
		await symlink(outside, `${lockPath}.guard.sqlite`);

		await expect(acquireFileLock(lockPath)).rejects.toThrow("symbolic link");
		expect(await readFile(outside, "utf8")).toBe("sentinel");
	});
});
