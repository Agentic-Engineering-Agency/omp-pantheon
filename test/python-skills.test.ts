import { createHash } from "node:crypto";
import {
	chmod,
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

import { privateProjectAreaRoot } from "../extensions/oh-my-omp/private-state";
import { PythonSkillEnvironment } from "../extensions/oh-my-omp/python-skills/environment";
import {
	PythonSkillManifestError,
	validatePythonSkillManifest,
	validatePythonSkillManifests,
} from "../extensions/oh-my-omp/python-skills/manifest";
import {
	PythonSkillRunner,
	PythonSkillRunnerError,
} from "../extensions/oh-my-omp/python-skills/runner";

const roots: string[] = [];
const pythonPath = Bun.which("python3");

async function createRoot() {
	const root = await mkdtemp(join(tmpdir(), "pantheon-python-skill-"));
	roots.push(root);
	return root;
}

function validManifest(overrides: Record<string, unknown> = {}) {
	return validatePythonSkillManifest({
		id: "echo-skill",
		python: ">=3.11,<3.15",
		dependencies: [],
		entrypoint: "main.py",
		timeoutMs: 1_000,
		environment: [],
		network: "inherit",
		maxOutputBytes: 4_096,
		input: { type: "object", required: ["message"] },
		output: { type: "object", required: ["message"] },
		...overrides,
	});
}

function manifestEnvironmentHash(manifest: ReturnType<typeof validManifest>) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				python: manifest.python,
				dependencies: [...manifest.dependencies].sort(),
			}),
		)
		.digest("hex");
}
function pythonStateHome(root: string): string {
	return join(root, ".state");
}

function pythonCacheRoot(root: string): string {
	return join(
		privateProjectAreaRoot(root, "python-skills", pythonStateHome(root)),
		"venvs",
	);
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("Python skill manifest", () => {
	test("accepts a bounded declarative runtime contract", () => {
		expect(validManifest()).toMatchObject({
			id: "echo-skill",
			entrypoint: "main.py",
			network: "inherit",
			maxOutputBytes: 4_096,
		});
	});

	test("rejects unpinned dependencies, traversal, and duplicate environment keys", () => {
		expect(() => validManifest({ dependencies: ["requests"] })).toThrow(
			"pinned",
		);
		expect(() => validManifest({ entrypoint: "../escape.py" })).toThrow(
			"entrypoint",
		);
		expect(() => validManifest({ environment: ["TOKEN", "TOKEN"] })).toThrow(
			"duplicate",
		);
		expect(() => validManifest({ timeoutMs: 0 })).toThrow(
			PythonSkillManifestError,
		);
	});

	test("rejects duplicate skill IDs across a manifest collection", () => {
		expect(() =>
			validatePythonSkillManifests([
				validManifest(),
				validManifest({ entrypoint: "other.py" }),
			]),
		).toThrow("duplicate skill id");
	});
});

describe("Python skill environment", () => {
	test("creates and reuses a content-addressed virtualenv", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		const environment = new PythonSkillEnvironment(root, {
			pythonPath,
			stateHome: pythonStateHome(root),
		});

		const first = await environment.provision(validManifest());
		const second = await environment.provision(validManifest());

		expect(first.pythonPath.startsWith(pythonCacheRoot(root))).toBe(true);
		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(second.pythonPath).toBe(first.pythonPath);
		expect(await Bun.file(first.pythonPath).exists()).toBe(true);
	}, 20_000);

	test("recovers an orphaned stale provisioning lock", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		const manifest = validManifest();
		const environmentHash = manifestEnvironmentHash(manifest);
		const lockPath = join(pythonCacheRoot(root), `${environmentHash}.lock`);
		await mkdir(pythonCacheRoot(root), { recursive: true });
		await writeFile(
			lockPath,
			JSON.stringify({
				token: "dead-owner",
				pid: 2_147_483_647,
				acquiredAt: "2000-01-01T00:00:00.000Z",
			}),
		);
		const environment = new PythonSkillEnvironment(root, {
			pythonPath,
			lockTimeoutMs: 2_000,
			staleLockMs: 10,
			stateHome: pythonStateHome(root),
		});

		const provisioned = await environment.provision(manifest);

		expect(provisioned.reused).toBe(false);
		expect(await Bun.file(provisioned.pythonPath).exists()).toBe(true);
	}, 20_000);

	test("refuses a symlinked private environment cache", async () => {
		const root = await createRoot();
		const outside = await createRoot();
		await mkdir(
			privateProjectAreaRoot(root, "python-skills", pythonStateHome(root)),
			{ recursive: true },
		);
		await symlink(outside, pythonCacheRoot(root), "dir");
		const environment = new PythonSkillEnvironment(root, {
			pythonPath: pythonPath ?? "python3",
			stateHome: pythonStateHome(root),
		});

		await expect(environment.provision(validManifest())).rejects.toThrow(
			"symbolic link",
		);
	});

	test("rejects a symlinked content-addressed environment directory", async () => {
		const root = await createRoot();
		const outside = await createRoot();
		const manifest = validManifest();
		const environmentPath = join(
			pythonCacheRoot(root),
			manifestEnvironmentHash(manifest),
		);
		await mkdir(pythonCacheRoot(root), { recursive: true });
		await symlink(outside, environmentPath, "dir");
		const environment = new PythonSkillEnvironment(root, {
			pythonPath: pythonPath ?? "python3",
			stateHome: pythonStateHome(root),
		});

		await expect(environment.provision(manifest)).rejects.toThrow(
			"owned directory",
		);
	});

	test("rejects a poisoned cached Python executable symlink", async () => {
		const root = await createRoot();
		const outside = await createRoot();
		const manifest = validManifest();
		const environmentPath = join(
			pythonCacheRoot(root),
			manifestEnvironmentHash(manifest),
		);
		await mkdir(join(environmentPath, "bin"), { recursive: true });
		const outsidePython = join(outside, "python");
		await writeFile(outsidePython, "sentinel");
		await symlink(outsidePython, join(environmentPath, "bin", "python"));
		const environment = new PythonSkillEnvironment(root, {
			pythonPath: pythonPath ?? "python3",
			stateHome: pythonStateHome(root),
		});

		await expect(environment.provision(manifest)).rejects.toThrow(
			"symbolic link",
		);
		expect(await readFile(outsidePython, "utf8")).toBe("sentinel");
	});

	test("kills the provisioning process tree on timeout", async () => {
		if (process.platform === "win32") return;
		const root = await createRoot();
		const pidPath = join(root, "provision-child.pid");
		const fakePython = join(root, "fake-python");
		await writeFile(
			fakePython,
			[
				"#!/bin/sh",
				"sleep 60 &",
				"child=$!",
				`printf '%s' "$child" > ${JSON.stringify(pidPath)}`,
				'wait "$child"',
			].join("\n"),
		);
		await chmod(fakePython, 0o755);
		const environment = new PythonSkillEnvironment(root, {
			pythonPath: fakePython,
			provisioningTimeoutMs: 1_000,
			stateHome: pythonStateHome(root),
		});

		await expect(environment.provision(validManifest())).rejects.toThrow(
			"Timed out",
		);
		const childPid = Number(await readFile(pidPath, "utf8"));
		let childAlive = true;
		for (let attempt = 0; attempt < 20 && childAlive; attempt += 1) {
			try {
				process.kill(childPid, 0);
				await Bun.sleep(10);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				childAlive = false;
			}
		}
		expect(childAlive).toBe(false);
	});
});

describe("Python skill runner", () => {
	test("passes one JSON value through stdin/stdout with an environment allowlist", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		await writeFile(
			join(root, "main.py"),
			'import json, os, sys\ndata = json.load(sys.stdin)\njson.dump({"message": data["message"], "allowed": os.getenv("ALLOWED"), "secret": os.getenv("SECRET")}, sys.stdout)\n',
		);
		const runner = new PythonSkillRunner(
			{ provision: async () => ({ pythonPath, reused: true }) },
			{
				environment: { ALLOWED: "yes", SECRET: "hidden" },
				allowedEnvironment: ["ALLOWED"],
			},
		);

		const result = await runner.run(
			root,
			validManifest({ environment: ["ALLOWED"] }),
			{ message: "hello" },
		);

		expect(result.output).toEqual({
			message: "hello",
			allowed: "yes",
			secret: null,
		});
		expect(result.stderr).toBe("");
	});

	test("serializes and validates input before provisioning or spawning", async () => {
		const root = await createRoot();
		await writeFile(join(root, "main.py"), 'print("{}")\n');
		let provisionCalls = 0;
		const runner = new PythonSkillRunner({
			async provision() {
				provisionCalls += 1;
				return {
					pythonPath: Bun.which("true") ?? "/usr/bin/true",
					reused: true,
				};
			},
		});
		const input: { message: string; self?: unknown } = { message: "hello" };
		input.self = input;

		await expect(runner.run(root, validManifest(), input)).rejects.toThrow(
			PythonSkillRunnerError,
		);
		expect(provisionCalls).toBe(0);
	});

	test("rejects an entrypoint symlink outside the skill root", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		const outside = await createRoot();
		const outsideEntrypoint = join(outside, "outside.py");
		await writeFile(outsideEntrypoint, 'print("{}")\n');
		await symlink(outsideEntrypoint, join(root, "main.py"));
		const runner = new PythonSkillRunner({
			provision: async () => ({ pythonPath, reused: true }),
		});

		await expect(
			runner.run(root, validManifest(), { message: "hello" }),
		).rejects.toThrow("symbolic link");
	});

	test("kills the Python process tree when execution times out", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		const pidPath = join(root, "child.pid");
		await writeFile(
			join(root, "main.py"),
			[
				"import pathlib, subprocess, sys, time",
				`child = subprocess.Popen([sys.executable, \"-c\", \"import time; time.sleep(60)\"])`,
				`pathlib.Path(${JSON.stringify(pidPath)}).write_text(str(child.pid))`,
				"time.sleep(60)",
			].join("\n"),
		);
		const runner = new PythonSkillRunner({
			provision: async () => ({ pythonPath, reused: true }),
		});

		await expect(
			runner.run(root, validManifest({ timeoutMs: 300 }), {
				message: "hello",
			}),
		).rejects.toThrow("timed out");
		const childPid = Number(await readFile(pidPath, "utf8"));
		let childAlive = true;
		for (let attempt = 0; attempt < 20 && childAlive; attempt += 1) {
			try {
				process.kill(childPid, 0);
				await Bun.sleep(10);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				childAlive = false;
			}
		}
		expect(childAlive).toBe(false);
	});

	test("rejects manifest-requested environment without host authorization", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		await writeFile(
			join(root, "main.py"),
			"import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n",
		);
		const runner = new PythonSkillRunner(
			{ provision: async () => ({ pythonPath, reused: true }) },
			{
				environment: { SECRET: "hidden" },
				allowedEnvironment: [],
			},
		);

		await expect(
			runner.run(root, validManifest({ environment: ["SECRET"] }), {
				message: "hello",
			}),
		).rejects.toThrow("not host-authorized");
	});

	test("rejects schema errors, oversized output, timeout, and unsupported network denial", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		const runner = new PythonSkillRunner({
			provision: async () => ({ pythonPath, reused: true }),
		});

		await writeFile(join(root, "main.py"), 'print("x" * 10000)\n');
		await expect(
			runner.run(root, validManifest({ maxOutputBytes: 100 }), {
				message: "hello",
			}),
		).rejects.toThrow("maximum output");

		await writeFile(
			join(root, "main.py"),
			"import time\ntime.sleep(2)\nprint('{}')\n",
		);
		await expect(
			runner.run(root, validManifest({ timeoutMs: 20 }), { message: "hello" }),
		).rejects.toThrow("timed out");

		await expect(
			runner.run(root, validManifest({ network: "deny" }), {
				message: "hello",
			}),
		).rejects.toThrow("network sandbox");
		await expect(runner.run(root, validManifest(), {})).rejects.toBeInstanceOf(
			PythonSkillRunnerError,
		);
	});

	test("rejects a nonzero process exit and output contract mismatch", async () => {
		if (!pythonPath) throw new Error("python3 is required for this test");
		const root = await createRoot();
		const runner = new PythonSkillRunner({
			provision: async () => ({ pythonPath, reused: true }),
		});
		await mkdir(join(root, "nested"));
		await writeFile(
			join(root, "main.py"),
			'import sys\nsys.stderr.write("broken")\nsys.exit(3)\n',
		);
		await expect(
			runner.run(root, validManifest(), { message: "hello" }),
		).rejects.toThrow("exit code 3");

		await writeFile(join(root, "main.py"), 'print("{}")\n');
		await expect(
			runner.run(root, validManifest(), { message: "hello" }),
		).rejects.toThrow("output contract");
	});
});
