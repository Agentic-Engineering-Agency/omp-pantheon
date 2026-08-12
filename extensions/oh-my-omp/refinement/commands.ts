import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { RefinementLedger } from "./ledger";
import type { RefinementProposal } from "./schema";

interface RefinementCommandRequest {
	action:
		| "propose"
		| "validate"
		| "approve"
		| "activate"
		| "reject"
		| "rollback"
		| "quarantine";
	id?: string;
	artifact?: string;
	candidate?: string;
	author?: string;
	source?: string;
	parentId?: string;
	evidence?: string;
	approvedBy?: string;
	reason?: string;
}

function parseRequest(raw: string): RefinementCommandRequest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error("Refinement command requires one JSON object", {
			cause: error,
		});
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("action" in value) ||
		typeof value.action !== "string" ||
		![
			"propose",
			"validate",
			"approve",
			"activate",
			"reject",
			"rollback",
			"quarantine",
		].includes(value.action)
	) {
		throw new Error("Refinement command has an invalid action");
	}
	return value as RefinementCommandRequest;
}

function requireField(
	request: RefinementCommandRequest,
	field: keyof RefinementCommandRequest,
): string {
	const value = request[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Refinement command requires ${field}`);
	}
	return value.trim();
}

async function readProjectFile(
	root: string,
	projectPath: string,
): Promise<Buffer> {
	if (projectPath.trim().length === 0 || isAbsolute(projectPath)) {
		throw new Error("Refinement file path must be project-relative");
	}
	const canonicalRoot = await realpath(root);
	const target = resolve(canonicalRoot, projectPath);
	const targetRelative = relative(canonicalRoot, target);
	if (
		targetRelative === ".." ||
		targetRelative.startsWith(`..${sep}`) ||
		isAbsolute(targetRelative)
	) {
		throw new Error("Refinement file path must stay within the project");
	}
	let current = canonicalRoot;
	for (const component of targetRelative.split(sep).filter(Boolean)) {
		current = resolve(current, component);
		const metadata = await lstat(current);
		if (metadata.isSymbolicLink()) {
			throw new Error(
				`Refinement file path contains a symbolic link: ${projectPath}`,
			);
		}
	}
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.nlink !== 1) {
			throw new Error("Refinement input must be a singly linked regular file");
		}
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

function hashContent(content: Uint8Array): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function registerRefinementCommand(pi: ExtensionAPI): void {
	pi.registerCommand("refinement", {
		description:
			"Human-operated refinement ledger: list, propose, validate, approve, activate, reject, rollback, quarantine",
		handler: async (rawArgs, ctx) => {
			const ledger = new RefinementLedger(ctx.cwd);
			try {
				if (rawArgs.trim() === "list") {
					const proposals = await ledger.list();
					ctx.ui.notify(
						proposals.length === 0
							? "No refinement proposals."
							: proposals
									.map(
										(item) => `${item.id} ${item.status} ${item.artifactPath}`,
									)
									.join("\n"),
						proposals.length === 0 ? "warning" : "info",
					);
					return;
				}
				const request = parseRequest(rawArgs);
				let proposal: RefinementProposal;
				switch (request.action) {
					case "propose": {
						const artifact = requireField(request, "artifact");
						const candidate = requireField(request, "candidate");
						const [baseBytes, candidateBytes] = await Promise.all([
							readProjectFile(ctx.cwd, artifact),
							readProjectFile(ctx.cwd, candidate),
						]);
						proposal = await ledger.propose({
							artifactPath: artifact,
							baseHash: hashContent(baseBytes),
							contentHash: hashContent(candidateBytes),
							author: requireField(request, "author"),
							source: requireField(request, "source"),
							parentId: request.parentId?.trim() || undefined,
						});
						break;
					}
					case "validate":
						proposal = await ledger.validate(
							requireField(request, "id"),
							requireField(request, "evidence"),
						);
						break;
					case "approve":
						proposal = await ledger.approve(
							requireField(request, "id"),
							requireField(request, "approvedBy"),
						);
						break;
					case "activate":
						proposal = await ledger.activate(
							requireField(request, "id"),
							await readProjectFile(
								ctx.cwd,
								requireField(request, "candidate"),
							),
						);
						break;
					case "reject":
						proposal = await ledger.reject(
							requireField(request, "id"),
							requireField(request, "reason"),
						);
						break;
					case "rollback":
						proposal = await ledger.rollback(
							requireField(request, "id"),
							requireField(request, "reason"),
						);
						break;
					case "quarantine":
						proposal = await ledger.quarantine(
							requireField(request, "id"),
							requireField(request, "reason"),
						);
						break;
				}
				ctx.ui.notify(
					`Refinement ${proposal.id} is ${proposal.status}.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
