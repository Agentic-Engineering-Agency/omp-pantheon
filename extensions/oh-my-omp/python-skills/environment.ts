import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { PythonSkillManifest } from "./manifest";

export interface ProvisionedPythonEnvironment {
	pythonPath: string;
	reused: boolean;
}

export interface PythonEnvironmentProvider {
	provision(
		manifest: PythonSkillManifest,
	): Promise<ProvisionedPythonEnvironment>;
}

export class PythonSkillEnvironmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PythonSkillEnvironmentError";
	}
}

export interface PythonSkillEnvironmentOptions {
	pythonPath?: string;
	lockTimeoutMs?: number;
}

export class PythonSkillEnvironment implements PythonEnvironmentProvider {
	private readonly root: string;
	private readonly pythonPath: string;
	private readonly lockTimeoutMs: number;

	constructor(
		projectRoot: string,
		options: PythonSkillEnvironmentOptions = {},
	) {
		this.root = join(projectRoot, ".pi", "python-skills", "venvs");
		this.pythonPath = options.pythonPath ?? "python3";
		this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
	}

	async provision(
		manifest: PythonSkillManifest,
	): Promise<ProvisionedPythonEnvironment> {
		const environmentHash = createHash("sha256")
			.update(
				JSON.stringify({
					python: manifest.python,
					dependencies: [...manifest.dependencies].sort(),
				}),
			)
			.digest("hex");
		const environmentPath = join(this.root, environmentHash);
		const environmentPython = join(
			environmentPath,
			process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
		);
		if (await Bun.file(environmentPython).exists()) {
			return { pythonPath: environmentPython, reused: true };
		}

		await mkdir(this.root, { recursive: true });
		const lockPath = `${environmentPath}.lock`;
		const deadline = Date.now() + this.lockTimeoutMs;
		let lock: FileHandle | null = null;
		while (lock === null) {
			try {
				lock = await open(lockPath, "wx");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (await Bun.file(environmentPython).exists()) {
					return { pythonPath: environmentPython, reused: true };
				}
				if (Date.now() >= deadline) {
					throw new PythonSkillEnvironmentError(
						`Timed out waiting for Python environment ${environmentHash}`,
					);
				}
				await Bun.sleep(25);
			}
		}

		const temporaryPath = `${environmentPath}.${randomUUID()}.tmp`;
		try {
			if (await Bun.file(environmentPython).exists()) {
				return { pythonPath: environmentPython, reused: true };
			}
			await this.assertPythonVersion(manifest.python);
			await this.run(
				[this.pythonPath, "-m", "venv", temporaryPath],
				"create virtualenv",
			);
			const temporaryPython = join(
				temporaryPath,
				process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
			);
			if (manifest.dependencies.length > 0) {
				await this.run(
					[
						temporaryPython,
						"-m",
						"pip",
						"install",
						"--disable-pip-version-check",
						"--no-input",
						...manifest.dependencies,
					],
					"install pinned dependencies",
				);
			}
			await rename(temporaryPath, environmentPath);
			return { pythonPath: environmentPython, reused: false };
		} finally {
			await lock.close();
			await rm(lockPath, { force: true });
			await rm(temporaryPath, { recursive: true, force: true });
		}
	}

	private async assertPythonVersion(requirement: string): Promise<void> {
		const processHandle = Bun.spawn({
			cmd: [
				this.pythonPath,
				"-c",
				"import sys; print('.'.join(map(str, sys.version_info[:3])))",
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, output, diagnostics] = await Promise.all([
			processHandle.exited,
			new Response(processHandle.stdout).text(),
			new Response(processHandle.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new PythonSkillEnvironmentError(
				`Unable to inspect Python runtime: ${diagnostics.trim()}`,
			);
		}
		const [minimum, maximum] = requirement.split(",");
		const version = output.trim().split(".").map(Number);
		const lower = minimum?.slice(2).split(".").map(Number) ?? [];
		const upper = maximum?.slice(1).split(".").map(Number) ?? [];
		const compare = (left: number[], right: number[]) => {
			for (let index = 0; index < 3; index += 1) {
				const difference = (left[index] ?? 0) - (right[index] ?? 0);
				if (difference !== 0) return difference;
			}
			return 0;
		};
		if (compare(version, lower) < 0 || compare(version, upper) >= 0) {
			throw new PythonSkillEnvironmentError(
				`Python ${output.trim()} does not satisfy ${requirement}`,
			);
		}
	}

	private async run(command: string[], action: string): Promise<void> {
		const processHandle = Bun.spawn({
			cmd: command,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, diagnostics] = await Promise.all([
			processHandle.exited,
			new Response(processHandle.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new PythonSkillEnvironmentError(
				`Failed to ${action}: ${diagnostics.trim()}`,
			);
		}
	}
}
