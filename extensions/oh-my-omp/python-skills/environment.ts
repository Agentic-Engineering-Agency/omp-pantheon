import { createHash, randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { acquireFileLock } from "../file-lock";
import {
	assertNoSymlinkComponents,
	ensurePrivateDirectory,
} from "../private-files";

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
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PythonSkillEnvironmentError";
	}
}

export interface PythonSkillEnvironmentOptions {
	pythonPath?: string;
	lockTimeoutMs?: number;
	staleLockMs?: number;
	provisioningTimeoutMs?: number;
}

export class PythonSkillEnvironment implements PythonEnvironmentProvider {
	private readonly root: string;
	private readonly pythonPath: string;
	private readonly lockTimeoutMs: number;
	private readonly staleLockMs: number;
	private readonly provisioningTimeoutMs: number;

	constructor(
		private readonly projectRoot: string,
		options: PythonSkillEnvironmentOptions = {},
	) {
		this.root = join(projectRoot, ".pi", "python-skills", "venvs");
		this.pythonPath = options.pythonPath ?? "python3";
		this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
		this.staleLockMs = options.staleLockMs ?? 5 * 60_000;
		this.provisioningTimeoutMs = options.provisioningTimeoutMs ?? 120_000;
	}

	async provision(
		manifest: PythonSkillManifest,
	): Promise<ProvisionedPythonEnvironment> {
		await assertNoSymlinkComponents(this.projectRoot, this.root);
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

		await ensurePrivateDirectory(this.root);
		const lockPath = `${environmentPath}.lock`;
		let release: () => Promise<void>;
		try {
			release = await acquireFileLock(lockPath, {
				timeoutMs: this.lockTimeoutMs,
				staleMs: this.staleLockMs,
			});
		} catch (error) {
			throw new PythonSkillEnvironmentError(
				`Timed out waiting for Python environment ${environmentHash}`,
				{ cause: error },
			);
		}

		const temporaryPath = `${environmentPath}.${randomUUID()}.tmp`;
		try {
			if (await Bun.file(environmentPython).exists()) {
				return { pythonPath: environmentPython, reused: true };
			}
			if (manifest.network === "deny" && manifest.dependencies.length > 0) {
				throw new PythonSkillEnvironmentError(
					"Cannot provision uncached dependencies for a network-denied Python skill",
				);
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
			await release();
			await rm(temporaryPath, { recursive: true, force: true });
		}
	}

	private async assertPythonVersion(requirement: string): Promise<void> {
		const { stdout: output } = await this.spawn(
			[
				this.pythonPath,
				"-c",
				"import sys; print('.'.join(map(str, sys.version_info[:3])))",
			],
			"inspect Python runtime",
		);
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
		await this.spawn(command, action);
	}

	private async spawn(
		command: string[],
		action: string,
	): Promise<{ stdout: string; stderr: string }> {
		const environment: Record<string, string> = {};
		for (const name of [
			"HOME",
			"PATH",
			"TMPDIR",
			"TMP",
			"TEMP",
			"SYSTEMROOT",
			"WINDIR",
		]) {
			const value = process.env[name];
			if (value !== undefined) environment[name] = value;
		}
		const processHandle = Bun.spawn({
			cmd: command,
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			processHandle.kill("SIGKILL");
		}, this.provisioningTimeoutMs);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				processHandle.exited,
				new Response(processHandle.stdout).text(),
				new Response(processHandle.stderr).text(),
			]);
			if (timedOut) {
				throw new PythonSkillEnvironmentError(
					`Timed out attempting to ${action} after ${this.provisioningTimeoutMs}ms`,
				);
			}
			if (exitCode !== 0) {
				throw new PythonSkillEnvironmentError(
					`Failed to ${action}: ${stderr.trim()}`,
				);
			}
			return { stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	}
}
