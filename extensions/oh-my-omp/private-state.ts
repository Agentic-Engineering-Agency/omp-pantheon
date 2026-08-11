import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
	assertNoSymlinkComponents,
	ensurePrivateDirectory,
} from "./private-files";

export type PrivateStateArea = "autonomy" | "python-skills" | "specsafe";

export function resolvedPrivateStateHome(stateHome?: string): string {
	return resolve(
		stateHome ??
			process.env.XDG_STATE_HOME ??
			join(homedir(), ".local", "state"),
	);
}

export function privateProjectKey(projectRoot: string): string {
	const resolvedProjectRoot = resolve(projectRoot);
	const canonicalProjectRoot = realpathSync(resolvedProjectRoot);
	return createHash("sha256")
		.update(canonicalProjectRoot)
		.digest("hex")
		.slice(0, 24);
}

export function privateProjectAreaRoot(
	projectRoot: string,
	area: PrivateStateArea,
	stateHome?: string,
): string {
	return join(
		resolvedPrivateStateHome(stateHome),
		"omp-pantheon",
		area,
		privateProjectKey(projectRoot),
	);
}

async function prepareStateHome(stateHome?: string): Promise<string> {
	const root = resolvedPrivateStateHome(stateHome);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(root);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error(`Private state home is not an owned directory: ${root}`);
	}
	return root;
}

export async function preparePrivateProjectAreaRoot(
	projectRoot: string,
	area: PrivateStateArea,
	stateHome?: string,
): Promise<string> {
	const root = await prepareStateHome(stateHome);
	const appRoot = join(root, "omp-pantheon");
	const areaRoot = join(appRoot, area);
	const projectAreaRoot = privateProjectAreaRoot(projectRoot, area, stateHome);
	for (const path of [appRoot, areaRoot, projectAreaRoot]) {
		await assertNoSymlinkComponents(root, path);
		await ensurePrivateDirectory(path);
	}
	return projectAreaRoot;
}

function ensurePrivateDirectorySync(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(path);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error(`Private state path is not an owned directory: ${path}`);
	}
	chmodSync(path, 0o700);
}

export function preparePrivateProjectAreaRootSync(
	projectRoot: string,
	area: PrivateStateArea,
	stateHome?: string,
): string {
	const root = resolvedPrivateStateHome(stateHome);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const rootMetadata = lstatSync(root);
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
		throw new Error(`Private state home is not an owned directory: ${root}`);
	}
	const appRoot = join(root, "omp-pantheon");
	const areaRoot = join(appRoot, area);
	const projectAreaRoot = privateProjectAreaRoot(projectRoot, area, stateHome);
	for (const path of [appRoot, areaRoot, projectAreaRoot]) {
		ensurePrivateDirectorySync(path);
	}
	return projectAreaRoot;
}
