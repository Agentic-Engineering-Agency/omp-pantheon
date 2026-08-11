import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");
const expectedOmpVersion = "^17.2.14";

describe("OMP dependency contract", () => {
	test("root and extension manifests and locks target OMP 17.2.14", async () => {
		const [rootContents, extensionContents, rootLock, extensionLock] =
			await Promise.all([
				readFile(join(root, "package.json"), "utf8"),
				readFile(join(root, "extensions", "oh-my-omp", "package.json"), "utf8"),
				readFile(join(root, "bun.lock"), "utf8"),
				readFile(join(root, "extensions", "oh-my-omp", "bun.lock"), "utf8"),
			]);
		const rootPackage = JSON.parse(rootContents) as {
			devDependencies?: Record<string, string>;
		};
		const extensionPackage = JSON.parse(extensionContents) as {
			devDependencies?: Record<string, string>;
		};

		expect(rootPackage.devDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe(
			expectedOmpVersion,
		);
		expect(
			extensionPackage.devDependencies?.["@oh-my-pi/pi-coding-agent"],
		).toBe(expectedOmpVersion);
		for (const lock of [rootLock, extensionLock]) {
			expect(lock).toContain('"@oh-my-pi/pi-coding-agent": "^17.2.14"');
			expect(lock).toContain('"@oh-my-pi/pi-coding-agent@17.2.14"');
			expect(lock).not.toContain("@oh-my-pi/pi-coding-agent@16.0.5");
		}
	});
});
