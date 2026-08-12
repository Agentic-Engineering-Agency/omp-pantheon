import { join } from "node:path";

import { ensurePrivateDirectory } from "../private-files";
import {
	preparePrivateProjectAreaRoot,
	privateProjectAreaRoot,
} from "../private-state";

function autonomyProjectRoot(projectRoot: string, stateHome?: string): string {
	return privateProjectAreaRoot(projectRoot, "autonomy", stateHome);
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
	await preparePrivateProjectAreaRoot(projectRoot, "autonomy", stateHome);
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
