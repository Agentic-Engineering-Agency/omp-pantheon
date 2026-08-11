import { isAbsolute, relative, resolve, sep } from "node:path";

import type { PythonEnvironmentProvider } from "./environment";
import type { JsonObjectContract, PythonSkillManifest } from "./manifest";

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

export class PythonSkillRunner {
	private readonly sourceEnvironment: Record<string, string | undefined>;
	private readonly networkSandbox?: PythonNetworkSandbox;

	constructor(
		private readonly environmentProvider: PythonEnvironmentProvider,
		options: PythonSkillRunnerOptions = {},
	) {
		this.sourceEnvironment = options.environment ?? process.env;
		this.networkSandbox = options.networkSandbox;
	}

	async run(
		skillRoot: string,
		manifest: PythonSkillManifest,
		input: unknown,
	): Promise<PythonSkillRunResult> {
		assertObjectContract(input, manifest.input, "input");
		if (manifest.network === "deny" && this.networkSandbox === undefined) {
			throw new PythonSkillRunnerError(
				"Python skill requests network denial but no network sandbox is available",
			);
		}
		const entrypoint = resolve(skillRoot, manifest.entrypoint);
		const entrypointRelative = relative(resolve(skillRoot), entrypoint);
		if (
			isAbsolute(entrypointRelative) ||
			entrypointRelative === ".." ||
			entrypointRelative.startsWith(`..${sep}`)
		) {
			throw new PythonSkillRunnerError(
				"Python skill entrypoint escapes its skill directory",
			);
		}
		if (!(await Bun.file(entrypoint).exists())) {
			throw new PythonSkillRunnerError(
				`Python skill entrypoint does not exist: ${manifest.entrypoint}`,
			);
		}

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
			const value = this.sourceEnvironment[name];
			if (value !== undefined) environment[name] = value;
		}

		const processHandle = Bun.spawn({
			cmd: command,
			cwd: skillRoot,
			env: environment,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		processHandle.stdin.write(`${JSON.stringify(input)}\n`);
		processHandle.stdin.end();

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			processHandle.kill("SIGKILL");
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
				processHandle.kill("SIGKILL");
				await processHandle.exited;
				throw error;
			}
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
