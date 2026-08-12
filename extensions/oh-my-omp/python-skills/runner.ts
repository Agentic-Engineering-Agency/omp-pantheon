import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
	chmod,
	lstat,
	mkdtemp,
	open,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PythonEnvironmentProvider } from "./environment";
import type { JsonObjectContract, PythonSkillManifest } from "./manifest";
import { terminateProcessTree } from "./process-tree";

export class PythonSkillRunnerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PythonSkillRunnerError";
	}
}

export interface PythonNetworkSandbox {
	buildCommand(pythonPath: string, entrypoint: string): string[];
}

export interface PythonSkillRunnerOptions {
	environment?: Record<string, string | undefined>;
	allowedEnvironment?: readonly string[];
	networkSandbox?: PythonNetworkSandbox;
}

export interface PythonSkillRunResult {
	output: unknown;
	stderr: string;
	reusedEnvironment: boolean;
}

function assertObjectContract(
	value: unknown,
	contract: JsonObjectContract,
	label: string,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PythonSkillRunnerError(
			`Python skill ${label} contract requires an object`,
		);
	}
	for (const key of contract.required) {
		if (!(key in value)) {
			throw new PythonSkillRunnerError(
				`Python skill ${label} contract requires property ${key}`,
			);
		}
	}
}

async function collectBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number,
	label: string,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > maximumBytes) {
			await reader.cancel();
			throw new PythonSkillRunnerError(
				`Python skill exceeded maximum ${label} of ${maximumBytes} bytes`,
			);
		}
		chunks.push(value);
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function assertNoSymbolicLinkComponents(
	root: string,
	target: string,
	label: string,
): Promise<void> {
	const relativeTarget = relative(root, target);
	if (
		isAbsolute(relativeTarget) ||
		relativeTarget === ".." ||
		relativeTarget.startsWith(`..${sep}`)
	) {
		throw new PythonSkillRunnerError(`${label} escapes its skill directory`);
	}
	let current = root;
	for (const component of relativeTarget.split(sep).filter(Boolean)) {
		current = resolve(current, component);
		let metadata: Stats;
		try {
			metadata = await lstat(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new PythonSkillRunnerError(`${label} does not exist: ${current}`);
			}
			throw error;
		}
		if (metadata.isSymbolicLink()) {
			throw new PythonSkillRunnerError(
				`${label} contains a symbolic link: ${current}`,
			);
		}
	}
}

interface FilesystemIdentity {
	dev: number | bigint;
	ino: number | bigint;
}

interface EntrypointApproval {
	entrypoint: string;
	skillRoot: string;
	rootIdentity: FilesystemIdentity;
	entrypointIdentity: FilesystemIdentity;
	entrypointHash?: string;
}

interface SafeEntrypoint extends EntrypointApproval {
	entrypointHash: string;
}

function filesystemIdentity(metadata: Stats): FilesystemIdentity {
	return { dev: metadata.dev, ino: metadata.ino };
}

function sameFilesystemIdentity(
	left: FilesystemIdentity,
	right: FilesystemIdentity,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function assertStableSkillRoot(
	safePaths: EntrypointApproval,
): Promise<void> {
	const metadata = await lstat(safePaths.skillRoot);
	if (
		metadata.isSymbolicLink() ||
		!metadata.isDirectory() ||
		!sameFilesystemIdentity(
			filesystemIdentity(metadata),
			safePaths.rootIdentity,
		)
	) {
		throw new PythonSkillRunnerError(
			"Python skill root changed after entrypoint approval",
		);
	}
}

function assertContained(root: string, target: string, message: string): void {
	const targetRelative = relative(root, target);
	if (
		isAbsolute(targetRelative) ||
		targetRelative === ".." ||
		targetRelative.startsWith(`..${sep}`)
	) {
		throw new PythonSkillRunnerError(message);
	}
}

async function readVerifiedEntrypointBytes(
	safePaths: EntrypointApproval,
): Promise<Uint8Array> {
	await assertStableSkillRoot(safePaths);
	await assertNoSymbolicLinkComponents(
		safePaths.skillRoot,
		safePaths.entrypoint,
		"Python skill entrypoint",
	);
	const handle = await open(
		safePaths.entrypoint,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		const descriptorMetadata = await handle.stat();
		if (!descriptorMetadata.isFile() || descriptorMetadata.nlink !== 1) {
			throw new PythonSkillRunnerError(
				"Python skill entrypoint must be a singly linked regular file",
			);
		}
		const pathMetadata = await lstat(safePaths.entrypoint);
		if (
			pathMetadata.isSymbolicLink() ||
			!sameFilesystemIdentity(
				filesystemIdentity(descriptorMetadata),
				filesystemIdentity(pathMetadata),
			)
		) {
			throw new PythonSkillRunnerError(
				"Python skill entrypoint changed while opening",
			);
		}
		if (
			!sameFilesystemIdentity(
				filesystemIdentity(descriptorMetadata),
				safePaths.entrypointIdentity,
			)
		) {
			throw new PythonSkillRunnerError(
				"Python skill entrypoint changed after provisioning",
			);
		}
		const realEntrypoint = await realpath(safePaths.entrypoint);
		assertContained(
			safePaths.skillRoot,
			realEntrypoint,
			"Python skill entrypoint escapes its real skill directory",
		);
		const bytes = await handle.readFile();
		if (
			safePaths.entrypointHash !== undefined &&
			hashBytes(bytes) !== safePaths.entrypointHash
		) {
			throw new PythonSkillRunnerError(
				"Python skill entrypoint bytes changed after provisioning",
			);
		}
		await assertStableSkillRoot(safePaths);
		return bytes;
	} finally {
		await handle.close();
	}
}

async function resolveSafeEntrypoint(
	skillRoot: string,
	manifestEntrypoint: string,
): Promise<SafeEntrypoint> {
	const resolvedSkillRoot = resolve(skillRoot);
	const rootMetadata = await lstat(resolvedSkillRoot);
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
		throw new PythonSkillRunnerError(
			"Python skill root must be a non-symbolic-link directory",
		);
	}
	const realSkillRoot = await realpath(resolvedSkillRoot);
	const realRootMetadata = await lstat(realSkillRoot);
	if (realRootMetadata.isSymbolicLink() || !realRootMetadata.isDirectory()) {
		throw new PythonSkillRunnerError(
			"Python skill root must resolve to a non-symbolic-link directory",
		);
	}
	const entrypoint = resolve(realSkillRoot, manifestEntrypoint);
	assertContained(
		realSkillRoot,
		entrypoint,
		"Python skill entrypoint escapes its skill directory",
	);
	await assertNoSymbolicLinkComponents(
		realSkillRoot,
		entrypoint,
		"Python skill entrypoint",
	);
	const entrypointMetadata = await lstat(entrypoint);
	if (!entrypointMetadata.isFile() || entrypointMetadata.nlink !== 1) {
		throw new PythonSkillRunnerError(
			"Python skill entrypoint must be a singly linked regular file",
		);
	}
	const realEntrypoint = await realpath(entrypoint);
	assertContained(
		realSkillRoot,
		realEntrypoint,
		"Python skill entrypoint escapes its real skill directory",
	);
	const rootIdentity = filesystemIdentity(realRootMetadata);
	const entrypointIdentity = filesystemIdentity(entrypointMetadata);
	const entrypointHash = hashBytes(
		await readVerifiedEntrypointBytes({
			entrypoint: realEntrypoint,
			skillRoot: realSkillRoot,
			rootIdentity,
			entrypointIdentity,
		}),
	);
	return {
		entrypoint: realEntrypoint,
		skillRoot: realSkillRoot,
		rootIdentity,
		entrypointIdentity,
		entrypointHash,
	};
}

async function stageEntrypoint(
	safePaths: SafeEntrypoint,
): Promise<{ directory: string; entrypoint: string }> {
	const entrypointBytes = await readVerifiedEntrypointBytes(safePaths);
	const directory = await mkdtemp(
		join(tmpdir(), "pantheon-python-entrypoint-"),
	);
	try {
		await chmod(directory, 0o700);
		const stagedEntrypoint = join(directory, basename(safePaths.entrypoint));
		await writeFile(stagedEntrypoint, entrypointBytes, { mode: 0o400 });
		await chmod(stagedEntrypoint, 0o400);
		return { directory, entrypoint: stagedEntrypoint };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export class PythonSkillRunner {
	private readonly sourceEnvironment: Record<string, string | undefined>;
	private readonly networkSandbox?: PythonNetworkSandbox;
	private readonly allowedEnvironment: ReadonlySet<string>;

	constructor(
		private readonly environmentProvider: PythonEnvironmentProvider,
		options: PythonSkillRunnerOptions = {},
	) {
		this.sourceEnvironment = options.environment ?? process.env;
		this.allowedEnvironment = new Set(options.allowedEnvironment ?? []);
		this.networkSandbox = options.networkSandbox;
	}

	async run(
		skillRoot: string,
		manifest: PythonSkillManifest,
		input: unknown,
	): Promise<PythonSkillRunResult> {
		assertObjectContract(input, manifest.input, "input");
		let serializedInput: string;
		try {
			const encoded = JSON.stringify(input);
			if (encoded === undefined) {
				throw new Error("JSON.stringify returned undefined");
			}
			assertObjectContract(JSON.parse(encoded), manifest.input, "input");
			serializedInput = encoded;
		} catch (error) {
			if (error instanceof PythonSkillRunnerError) throw error;
			throw new PythonSkillRunnerError(
				"Python skill input is not one JSON-serializable object",
				{ cause: error },
			);
		}
		if (manifest.network === "deny" && this.networkSandbox === undefined) {
			throw new PythonSkillRunnerError(
				"Python skill requests network denial but no network sandbox is available",
			);
		}
		const safePaths = await resolveSafeEntrypoint(
			skillRoot,
			manifest.entrypoint,
		);
		const provisioned = await this.environmentProvider.provision(manifest);
		const staged = await stageEntrypoint(safePaths);
		try {
			const command =
				manifest.network === "deny"
					? this.networkSandbox?.buildCommand(
							provisioned.pythonPath,
							staged.entrypoint,
						)
					: [provisioned.pythonPath, staged.entrypoint];
			if (command === undefined || command.length === 0) {
				throw new PythonSkillRunnerError(
					"Python network sandbox returned no command",
				);
			}
			const environment: Record<string, string> = {
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONNOUSERSITE: "1",
				PYTHONUNBUFFERED: "1",
				PANTHEON_NETWORK_POLICY: manifest.network,
			};
			for (const name of manifest.environment) {
				if (!this.allowedEnvironment.has(name)) {
					throw new PythonSkillRunnerError(
						`Python skill environment variable is not host-authorized: ${name}`,
					);
				}
			}
			for (const name of manifest.environment) {
				const value = this.sourceEnvironment[name];
				if (value !== undefined) environment[name] = value;
			}
			environment.PYTHONPATH = safePaths.skillRoot;

			const processHandle = Bun.spawn({
				cmd: command,
				cwd: safePaths.skillRoot,
				env: environment,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				detached: true,
			});
			processHandle.stdin.write(`${serializedInput}\n`);
			processHandle.stdin.end();

			let timedOut = false;
			let terminationPromise: Promise<void> | null = null;
			const terminate = (): Promise<void> => {
				terminationPromise ??= terminateProcessTree(processHandle);
				return terminationPromise;
			};
			const timer = setTimeout(() => {
				timedOut = true;
				void terminate().catch(() => undefined);
			}, manifest.timeoutMs);
			try {
				const stdoutPromise = collectBounded(
					processHandle.stdout,
					manifest.maxOutputBytes,
					"output",
				);
				const stderrPromise = collectBounded(
					processHandle.stderr,
					Math.min(manifest.maxOutputBytes, 65_536),
					"diagnostics",
				);
				let exitCode: number;
				let stdoutBytes: Uint8Array;
				let stderrBytes: Uint8Array;
				try {
					[exitCode, stdoutBytes, stderrBytes] = await Promise.all([
						processHandle.exited,
						stdoutPromise,
						stderrPromise,
					]);
				} catch (error) {
					await terminate();
					throw error;
				}
				if (timedOut) await terminate();
				if (timedOut) {
					throw new PythonSkillRunnerError(
						`Python skill timed out after ${manifest.timeoutMs}ms`,
					);
				}
				const stderr = new TextDecoder().decode(stderrBytes);
				if (exitCode !== 0) {
					throw new PythonSkillRunnerError(
						`Python skill exited with exit code ${exitCode}: ${stderr.trim()}`,
					);
				}
				let output: unknown;
				try {
					output = JSON.parse(new TextDecoder().decode(stdoutBytes));
				} catch (error) {
					throw new PythonSkillRunnerError(
						"Python skill output is not one valid JSON value",
						{ cause: error },
					);
				}
				assertObjectContract(output, manifest.output, "output");
				return {
					output,
					stderr,
					reusedEnvironment: provisioned.reused,
				};
			} finally {
				clearTimeout(timer);
			}
		} finally {
			await rm(staged.directory, { recursive: true, force: true });
		}
	}
}
