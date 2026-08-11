import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { acquireFileLock } from "../file-lock";
import {
	assertNoSymlinkComponents,
	ensurePrivateDirectory,
} from "../private-files";
import { terminateProcessTree } from "./process-tree";

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

const ENVIRONMENT_MARKER = ".pantheon-environment.json";

interface EnvironmentMarkerPayload {
	schemaVersion: 1;
	environmentHash: string;
	python: string;
	dependencies: string[];
	pythonSha256: string;
}

interface EnvironmentMarker extends EnvironmentMarkerPayload {
	checksum: string;
}

function checksum(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
		if (
			await this.validateExistingEnvironment(
				environmentPath,
				environmentPython,
				environmentHash,
				manifest,
			)
		) {
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
			if (
				await this.validateExistingEnvironment(
					environmentPath,
					environmentPython,
					environmentHash,
					manifest,
				)
			) {
				return { pythonPath: environmentPython, reused: true };
			}
			if (manifest.network === "deny" && manifest.dependencies.length > 0) {
				throw new PythonSkillEnvironmentError(
					"Cannot provision uncached dependencies for a network-denied Python skill",
				);
			}
			await this.assertPythonVersion(manifest.python);
			await this.run(
				[this.pythonPath, "-m", "venv", "--copies", temporaryPath],
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
			const pythonSha256 = createHash("sha256")
				.update(await readFile(temporaryPython))
				.digest("hex");
			const markerPayload: EnvironmentMarkerPayload = {
				schemaVersion: 1,
				environmentHash,
				python: manifest.python,
				dependencies: [...manifest.dependencies].sort(),
				pythonSha256,
			};
			const marker: EnvironmentMarker = {
				...markerPayload,
				checksum: checksum(markerPayload),
			};
			const markerPath = join(temporaryPath, ENVIRONMENT_MARKER);
			await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			await chmod(markerPath, 0o600);
			await rename(temporaryPath, environmentPath);
			if (
				!(await this.validateExistingEnvironment(
					environmentPath,
					environmentPython,
					environmentHash,
					manifest,
				))
			) {
				throw new PythonSkillEnvironmentError(
					"Python environment disappeared after provisioning",
				);
			}
			return { pythonPath: environmentPython, reused: false };
		} finally {
			await release();
			await rm(temporaryPath, { recursive: true, force: true });
		}
	}

	private async validateExistingEnvironment(
		environmentPath: string,
		environmentPython: string,
		environmentHash: string,
		manifest: PythonSkillManifest,
	): Promise<boolean> {
		let environmentMetadata: Awaited<ReturnType<typeof lstat>>;
		try {
			environmentMetadata = await lstat(environmentPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		if (
			environmentMetadata.isSymbolicLink() ||
			!environmentMetadata.isDirectory()
		) {
			throw new PythonSkillEnvironmentError(
				`Python environment cache is not an owned directory: ${environmentPath}`,
			);
		}
		const markerPath = join(environmentPath, ENVIRONMENT_MARKER);
		for (const path of [environmentPython, markerPath]) {
			await assertNoSymlinkComponents(this.projectRoot, path);
			const metadata = await lstat(path);
			if (
				metadata.isSymbolicLink() ||
				!metadata.isFile() ||
				metadata.nlink !== 1
			) {
				throw new PythonSkillEnvironmentError(
					`Python environment cache contains an unsafe file: ${path}`,
				);
			}
		}
		const [realEnvironment, realPython, realMarker] = await Promise.all([
			realpath(environmentPath),
			realpath(environmentPython),
			realpath(markerPath),
		]);
		for (const path of [realPython, realMarker]) {
			const relativePath = relative(realEnvironment, path);
			if (
				isAbsolute(relativePath) ||
				relativePath === ".." ||
				relativePath.startsWith(`..${sep}`)
			) {
				throw new PythonSkillEnvironmentError(
					`Python environment cache file escapes its environment: ${path}`,
				);
			}
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(markerPath, "utf8"));
		} catch (error) {
			throw new PythonSkillEnvironmentError(
				`Python environment marker is unreadable: ${markerPath}`,
				{ cause: error },
			);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed) ||
			!("checksum" in parsed) ||
			typeof parsed.checksum !== "string"
		) {
			throw new PythonSkillEnvironmentError(
				`Python environment marker is malformed: ${markerPath}`,
			);
		}
		const { checksum: actualChecksum, ...payload } = parsed;
		const expectedPayload: EnvironmentMarkerPayload = {
			schemaVersion: 1,
			environmentHash,
			python: manifest.python,
			dependencies: [...manifest.dependencies].sort(),
			pythonSha256: createHash("sha256")
				.update(await readFile(environmentPython))
				.digest("hex"),
		};
		if (
			actualChecksum !== checksum(payload) ||
			JSON.stringify(payload) !== JSON.stringify(expectedPayload)
		) {
			throw new PythonSkillEnvironmentError(
				`Python environment marker does not match its cache: ${markerPath}`,
			);
		}
		return true;
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
			detached: true,
		});
		let timedOut = false;
		let terminationPromise: Promise<void> | null = null;
		const terminate = (): Promise<void> => {
			terminationPromise ??= terminateProcessTree(processHandle);
			return terminationPromise;
		};
		const timer = setTimeout(() => {
			timedOut = true;
			void terminate().catch(() => undefined);
		}, this.provisioningTimeoutMs);
		try {
			let exitCode: number;
			let stdout: string;
			let stderr: string;
			try {
				[exitCode, stdout, stderr] = await Promise.all([
					processHandle.exited,
					new Response(processHandle.stdout).text(),
					new Response(processHandle.stderr).text(),
				]);
			} catch (error) {
				await terminate();
				throw error;
			}
			if (timedOut) await terminate();
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
