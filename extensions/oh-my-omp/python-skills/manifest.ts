import { isAbsolute, normalize, sep } from "node:path";

export interface JsonObjectContract {
	type: "object";
	required: string[];
}

export interface PythonSkillManifest {
	id: string;
	python: string;
	dependencies: string[];
	entrypoint: string;
	timeoutMs: number;
	environment: string[];
	network: "inherit" | "deny";
	maxOutputBytes: number;
	input: JsonObjectContract;
	output: JsonObjectContract;
}

export class PythonSkillManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PythonSkillManifestError";
	}
}

function requireString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new PythonSkillManifestError(
			`Python skill ${key} must be a non-empty string`,
		);
	}
	return value.trim();
}

function validateContract(value: unknown, name: string): JsonObjectContract {
	if (
		typeof value !== "object" ||
		value === null ||
		!("type" in value) ||
		value.type !== "object" ||
		!("required" in value) ||
		!Array.isArray(value.required) ||
		value.required.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new PythonSkillManifestError(
			`Python skill ${name} must be an object contract with required string keys`,
		);
	}
	const required = value.required as string[];
	if (new Set(required).size !== required.length) {
		throw new PythonSkillManifestError(
			`Python skill ${name} contract contains duplicate keys`,
		);
	}
	return { type: "object", required: [...required] };
}

export function validatePythonSkillManifest(
	value: unknown,
): PythonSkillManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PythonSkillManifestError(
			"Python skill manifest must be an object",
		);
	}
	const record = value as Record<string, unknown>;
	const id = requireString(record, "id");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		throw new PythonSkillManifestError(
			"Python skill id must use lowercase letters, digits, and hyphens",
		);
	}
	const python = requireString(record, "python");
	if (!/^>=\d+\.\d+(?:\.\d+)?,<\d+\.\d+(?:\.\d+)?$/.test(python)) {
		throw new PythonSkillManifestError(
			"Python skill python requirement must be a bounded >=version,<version range",
		);
	}
	if (
		!Array.isArray(record.dependencies) ||
		record.dependencies.some(
			(item) =>
				typeof item !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9_.-]*==[^=\s]+$/.test(item),
		)
	) {
		throw new PythonSkillManifestError(
			"Python skill dependencies must be pinned with package==version",
		);
	}
	const dependencies = record.dependencies as string[];
	if (new Set(dependencies).size !== dependencies.length) {
		throw new PythonSkillManifestError(
			"Python skill dependencies contain duplicate entries",
		);
	}

	const rawEntrypoint = requireString(record, "entrypoint");
	const entrypoint = normalize(rawEntrypoint);
	if (
		isAbsolute(rawEntrypoint) ||
		entrypoint === ".." ||
		entrypoint.startsWith(`..${sep}`) ||
		entrypoint.includes(sep) ||
		!entrypoint.endsWith(".py")
	) {
		throw new PythonSkillManifestError(
			"Python skill entrypoint must be one project-root .py file",
		);
	}
	if (
		typeof record.timeoutMs !== "number" ||
		!Number.isInteger(record.timeoutMs) ||
		record.timeoutMs < 1 ||
		record.timeoutMs > 300_000
	) {
		throw new PythonSkillManifestError(
			"Python skill timeoutMs must be an integer between 1 and 300000",
		);
	}
	if (
		!Array.isArray(record.environment) ||
		record.environment.some(
			(item) => typeof item !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(item),
		)
	) {
		throw new PythonSkillManifestError(
			"Python skill environment must contain valid uppercase variable names",
		);
	}
	const environment = record.environment as string[];
	if (new Set(environment).size !== environment.length) {
		throw new PythonSkillManifestError(
			"Python skill environment contains duplicate keys",
		);
	}
	if (record.network !== "inherit" && record.network !== "deny") {
		throw new PythonSkillManifestError(
			"Python skill network must be inherit or deny",
		);
	}
	if (
		typeof record.maxOutputBytes !== "number" ||
		!Number.isInteger(record.maxOutputBytes) ||
		record.maxOutputBytes < 1 ||
		record.maxOutputBytes > 10_485_760
	) {
		throw new PythonSkillManifestError(
			"Python skill maxOutputBytes must be an integer between 1 and 10485760",
		);
	}

	return {
		id,
		python,
		dependencies: [...dependencies],
		entrypoint,
		timeoutMs: record.timeoutMs,
		environment: [...environment],
		network: record.network,
		maxOutputBytes: record.maxOutputBytes,
		input: validateContract(record.input, "input"),
		output: validateContract(record.output, "output"),
	};
}

export function validatePythonSkillManifests(
	values: readonly unknown[],
): PythonSkillManifest[] {
	const manifests = values.map(validatePythonSkillManifest);
	const ids = new Set<string>();
	for (const manifest of manifests) {
		if (ids.has(manifest.id)) {
			throw new PythonSkillManifestError(
				`Python skill collection contains duplicate skill id: ${manifest.id}`,
			);
		}
		ids.add(manifest.id);
	}
	return manifests;
}
