import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ensurePrivateDirectory } from "../private-files";
import { privateProjectKey } from "../private-state";

function resolvedStateHome(stateHome?: string): string {
	return resolve(
		stateHome ??
			process.env.XDG_STATE_HOME ??
			join(homedir(), ".local", "state"),
	);
}

function autonomyProjectRoot(projectRoot: string, stateHome?: string): string {
	return join(
		resolvedStateHome(stateHome),
		"omp-pantheon",
		"autonomy",
		privateProjectKey(projectRoot),
	);
}

export function autonomyProjectStateRoot(
	projectRoot: string,
	stateHome?: string,
): string {
	return join(autonomyProjectRoot(projectRoot, stateHome), "state");
}

export function autonomyRuntimeRoot(
	projectRoot: string,
	runId: string,
	stateHome?: string,
): string {
	if (runId.trim().length === 0 || /[^A-Za-z0-9._-]/.test(runId)) {
		throw new Error("Autonomy run ID contains unsafe path characters");
	}
	return join(autonomyProjectRoot(projectRoot, stateHome), "runs", runId);
}

async function prepareProjectHierarchy(
	projectRoot: string,
	stateHome?: string,
): Promise<void> {
	const appRoot = join(resolvedStateHome(stateHome), "omp-pantheon");
	const autonomyRoot = join(appRoot, "autonomy");
	const projectRootPath = autonomyProjectRoot(projectRoot, stateHome);
	for (const path of [appRoot, autonomyRoot, projectRootPath]) {
		await ensurePrivateDirectory(path);
	}
}

export async function prepareAutonomyProjectStateRoot(
	projectRoot: string,
	stateHome?: string,
): Promise<string> {
	await prepareProjectHierarchy(projectRoot, stateHome);
	const path = autonomyProjectStateRoot(projectRoot, stateHome);
	await ensurePrivateDirectory(path);
	return path;
}

export async function prepareAutonomyRuntimeRoot(
	projectRoot: string,
	runId: string,
	stateHome?: string,
): Promise<string> {
	await prepareProjectHierarchy(projectRoot, stateHome);
	const runsRoot = join(autonomyProjectRoot(projectRoot, stateHome), "runs");
	await ensurePrivateDirectory(runsRoot);
	const path = autonomyRuntimeRoot(projectRoot, runId, stateHome);
	await ensurePrivateDirectory(path);
	return path;
}
