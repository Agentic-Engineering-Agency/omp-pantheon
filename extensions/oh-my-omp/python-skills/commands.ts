import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { PythonSkillEnvironment } from "./environment";
import {
	type PythonSkillManifest,
	validatePythonSkillManifest,
	validatePythonSkillManifests,
} from "./manifest";
import { PythonSkillRunner } from "./runner";

const SKILL_DIRECTORY = join(".omp", "python-skills");
const MANIFEST_FILE = "manifest.json";
const MAXIMUM_MANIFEST_BYTES = 256 * 1024;

interface InstalledPythonSkill {
	manifest: PythonSkillManifest;
	root: string;
}

async function readManifest(path: string): Promise<unknown> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			metadata.size > MAXIMUM_MANIFEST_BYTES
		) {
			throw new Error("Python skill manifest must be one bounded regular file");
		}
		return JSON.parse(await handle.readFile({ encoding: "utf8" }));
	} finally {
		await handle.close();
	}
}

async function discoverPythonSkills(
	projectRoot: string,
): Promise<InstalledPythonSkill[]> {
	const canonicalProject = await realpath(projectRoot);
	const skillsRoot = resolve(canonicalProject, SKILL_DIRECTORY);
	const skillsRelative = relative(canonicalProject, skillsRoot);
	if (skillsRelative === ".." || skillsRelative.startsWith(`..${sep}`)) {
		throw new Error("Python skill directory escapes the project");
	}
	let rootMetadata: Stats;
	try {
		rootMetadata = await lstat(skillsRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
		throw new Error(
			"Python skill directory must be a non-symbolic-link directory",
		);
	}
	const skills: InstalledPythonSkill[] = [];
	for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const root = join(skillsRoot, entry.name);
		const rootStats = await lstat(root);
		if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) continue;
		const manifestPath = join(root, MANIFEST_FILE);
		let manifestValue: unknown;
		try {
			manifestValue = await readManifest(manifestPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		skills.push({
			manifest: validatePythonSkillManifest(manifestValue),
			root,
		});
	}
	validatePythonSkillManifests(skills.map((skill) => skill.manifest));
	return skills.sort((left, right) =>
		left.manifest.id.localeCompare(right.manifest.id),
	);
}

function parseRunRequest(raw: string): { id: string; input: unknown } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error("Python skill run requires one JSON object", {
			cause: error,
		});
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		value.id.trim().length === 0 ||
		!("input" in value)
	) {
		throw new Error("Python skill run requires id and input");
	}
	return { id: value.id.trim(), input: value.input };
}

export function registerPythonSkillCommand(pi: ExtensionAPI): void {
	pi.registerCommand("python-skill", {
		description:
			"Human-operated Python skill bridge: list or run a manifest from .omp/python-skills",
		handler: async (rawArgs, ctx) => {
			try {
				const trimmed = rawArgs.trim();
				const skills = await discoverPythonSkills(ctx.cwd);
				if (trimmed === "list") {
					ctx.ui.notify(
						skills.length === 0
							? "No Python skills installed under .omp/python-skills."
							: skills.map((skill) => skill.manifest.id).join("\n"),
						skills.length === 0 ? "warning" : "info",
					);
					return;
				}
				if (!trimmed.startsWith("run ")) {
					throw new Error(
						'Usage: /python-skill list | run {"id":"skill-id","input":{...}}',
					);
				}
				const request = parseRunRequest(trimmed.slice("run ".length));
				const skill = skills.find((item) => item.manifest.id === request.id);
				if (skill === undefined) {
					throw new Error(`Unknown Python skill: ${request.id}`);
				}
				const runner = new PythonSkillRunner(
					new PythonSkillEnvironment(ctx.cwd),
				);
				const result = await runner.run(
					skill.root,
					skill.manifest,
					request.input,
				);
				ctx.ui.notify(JSON.stringify(result.output), "info");
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
