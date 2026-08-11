import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
		let metadata: Awaited<ReturnType<typeof lstat>>;
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

async function resolveSafeEntrypoint(
	skillRoot: string,
	manifestEntrypoint: string,
): Promise<{ entrypoint: string; skillRoot: string }> {
	const resolvedSkillRoot = resolve(skillRoot);
	const rootMetadata = await lstat(resolvedSkillRoot);
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
		throw new PythonSkillRunnerError(
			"Python skill root must be a non-symbolic-link directory",
		);
	}
	const realSkillRoot = await realpath(resolvedSkillRoot);
	const entrypoint = resolve(realSkillRoot, manifestEntrypoint);
	const entrypointRelative = relative(realSkillRoot, entrypoint);
	if (
		isAbsolute(entrypointRelative) ||
		entrypointRelative === ".." ||
		entrypointRelative.startsWith(`..${sep}`)
	) {
		throw new PythonSkillRunnerError(
			"Python skill entrypoint escapes its skill directory",
		);
	}
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
	const realRelative = relative(realSkillRoot, realEntrypoint);
	if (
		isAbsolute(realRelative) ||
		realRelative === ".." ||
		realRelative.startsWith(`..${sep}`)
	) {
		throw new PythonSkillRunnerError(
			"Python skill entrypoint escapes its real skill directory",
		);
	}
	return { entrypoint: realEntrypoint, skillRoot: realSkillRoot };
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
		const { entrypoint } = safePaths;

		const provisioned = await this.environmentProvider.provision(manifest);
		const command =
			manifest.network === "deny"
				? this.networkSandbox?.buildCommand(provisioned.pythonPath, entrypoint)
				: [provisioned.pythonPath, entrypoint];
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
	}
}
