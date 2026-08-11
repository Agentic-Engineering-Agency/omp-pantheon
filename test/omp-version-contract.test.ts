import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");
const expectedOmpVersion = "^17.2.14";

describe("OMP dependency contract", () => {
	test("root and extension target the supported OMP 17 release", async () => {
		const [rootContents, extensionContents] = await Promise.all([
			readFile(join(root, "package.json"), "utf8"),
			readFile(join(root, "extensions", "oh-my-omp", "package.json"), "utf8"),
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
	});
});
