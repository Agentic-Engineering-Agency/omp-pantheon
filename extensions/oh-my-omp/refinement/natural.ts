import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { RefinementLedger } from "./ledger";
import type { RefinementProposal } from "./schema";

const AUTHOR = "agent:natural-refinement";
const APPROVAL_WORD = "aprobar";
const CANCELLATION_WORD = "cancelar";

interface PreviewRequest {
	sessionId: string;
	root: string;
	artifact: string;
	candidate: string;
	evidence: string;
}

interface ApprovalRequest {
	sessionId: string;
	root: string;
}

interface PendingPreview {
	sessionId: string;
	root: string;
	artifact: string;
	candidate: string;
	evidence: string;
	baseHash: string;
	candidateHash: string;
}

export interface NaturalRefinementPreview {
	approval: typeof APPROVAL_WORD;
	sessionId: string;
	artifact: string;
	candidate: string;
	evidence: string;
	transaction: {
		action: "activate";
		approvedBy: string;
		steps: Array<Record<string, string>>;
	};
}

export interface NaturalRefinementRuntimeOptions {
	stateHome?: string;
}

export class NaturalRefinementRuntimeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "NaturalRefinementRuntimeError";
	}
}

interface ProjectFile {
	content: Buffer;
	identity: string;
}

async function readProjectFile(
	root: string,
	projectPath: string,
): Promise<ProjectFile> {
	if (projectPath.trim().length === 0 || isAbsolute(projectPath)) {
		throw new NaturalRefinementRuntimeError(
			"Refinement file path must be project-relative",
		);
	}
	const canonicalRoot = await realpath(root);
	const target = resolve(canonicalRoot, projectPath);
	const targetRelative = relative(canonicalRoot, target);
	if (
		targetRelative === ".." ||
		targetRelative.startsWith(`..${sep}`) ||
		isAbsolute(targetRelative)
	) {
		throw new NaturalRefinementRuntimeError(
			"Refinement file path must stay within the project",
		);
	}
	let current = canonicalRoot;
	for (const component of targetRelative.split(sep).filter(Boolean)) {
		current = resolve(current, component);
		const metadata = await lstat(current);
		if (metadata.isSymbolicLink()) {
			throw new NaturalRefinementRuntimeError(
				`Refinement file path contains a symbolic link: ${projectPath}`,
			);
		}
	}
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.nlink !== 1) {
			throw new NaturalRefinementRuntimeError(
				"Refinement input must be a singly linked regular file",
			);
		}
		return {
			content: await handle.readFile(),
			identity: `${metadata.dev}:${metadata.ino}`,
		};
	} finally {
		await handle.close();
	}
}

function hashContent(content: Uint8Array): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function sourceFor(sessionId: string): string {
	return `natural-refinement:${sessionId}`;
}

function approverFor(sessionId: string): string {
	return `user:session:${sessionId}`;
}
function renderPreview(preview: NaturalRefinementPreview): string {
	return [
		"Refinement preview prepared. No project artifact or ledger was changed.",
		"Review this transaction, then submit exactly `aprobar` to apply it or `cancelar` to discard it:",
		"```json",
		JSON.stringify(preview.transaction, null, 2),
		"```",
	].join("\n");
}

export class NaturalRefinementRuntime {
	private readonly pending = new Map<string, PendingPreview>();

	constructor(private readonly options: NaturalRefinementRuntimeOptions = {}) {}

	async preview(request: PreviewRequest): Promise<NaturalRefinementPreview> {
		if (request.evidence.trim().length === 0) {
			throw new NaturalRefinementRuntimeError(
				"Validation evidence must not be empty",
			);
		}
		if (this.pending.has(request.sessionId)) {
			throw new NaturalRefinementRuntimeError(
				"A pending refinement preview must be approved or discarded first",
			);
		}
		const root = await realpath(request.root);
		const [artifact, candidate] = await Promise.all([
			readProjectFile(root, request.artifact),
			readProjectFile(root, request.candidate),
		]);
		if (artifact.identity === candidate.identity) {
			throw new NaturalRefinementRuntimeError(
				"Refinement artifact and candidate must be different files",
			);
		}
		const pending: PendingPreview = {
			sessionId: request.sessionId,
			root,
			artifact: request.artifact,
			candidate: request.candidate,
			evidence: request.evidence.trim(),
			baseHash: hashContent(artifact.content),
			candidateHash: hashContent(candidate.content),
		};
		this.pending.set(request.sessionId, pending);
		const createdOnApproval = "<created-on-approval>";
		return {
			approval: APPROVAL_WORD,
			sessionId: request.sessionId,
			artifact: request.artifact,
			candidate: request.candidate,
			evidence: pending.evidence,
			transaction: {
				action: "activate",
				approvedBy: approverFor(request.sessionId),
				steps: [
					{
						action: "propose",
						artifact: request.artifact,
						candidate: request.candidate,
						author: AUTHOR,
						source: sourceFor(request.sessionId),
					},
					{
						action: "validate",
						id: createdOnApproval,
						evidence: pending.evidence,
					},
					{
						action: "approve",
						id: createdOnApproval,
						approvedBy: approverFor(request.sessionId),
					},
					{
						action: "activate",
						id: createdOnApproval,
						candidate: request.candidate,
					},
				],
			},
		};
	}

	async approve(request: ApprovalRequest): Promise<RefinementProposal> {
		const pending = this.pending.get(request.sessionId);
		if (!pending) {
			throw new NaturalRefinementRuntimeError(
				"No pending refinement preview for this session",
			);
		}
		const root = await realpath(request.root);
		if (root !== pending.root) {
			throw new NaturalRefinementRuntimeError(
				"Pending refinement preview belongs to a different project",
			);
		}
		const [artifact, candidate] = await Promise.all([
			readProjectFile(root, pending.artifact),
			readProjectFile(root, pending.candidate),
		]);
		if (hashContent(artifact.content) !== pending.baseHash) {
			this.pending.delete(request.sessionId);
			throw new NaturalRefinementRuntimeError(
				"Refinement artifact changed after the preview; prepare a new preview",
			);
		}
		if (hashContent(candidate.content) !== pending.candidateHash) {
			this.pending.delete(request.sessionId);
			throw new NaturalRefinementRuntimeError(
				"Refinement candidate changed after the preview; prepare a new preview",
			);
		}

		const ledger = new RefinementLedger(root, {
			stateHome: this.options.stateHome,
		});
		try {
			const proposed = await ledger.propose({
				artifactPath: pending.artifact,
				baseHash: pending.baseHash,
				contentHash: pending.candidateHash,
				author: AUTHOR,
				source: sourceFor(pending.sessionId),
			});
			await ledger.validate(proposed.id, pending.evidence);
			await ledger.approve(proposed.id, approverFor(pending.sessionId));
			return await ledger.activate(proposed.id, candidate.content);
		} finally {
			this.pending.delete(request.sessionId);
		}
	}
	discard(sessionId: string): boolean {
		return this.pending.delete(sessionId);
	}
	hasPending(sessionId: string): boolean {
		return this.pending.has(sessionId);
	}
}

export function registerNaturalRefinement(
	pi: ExtensionAPI,
	options: NaturalRefinementRuntimeOptions = {},
): NaturalRefinementRuntime {
	const runtime = new NaturalRefinementRuntime(options);
	const z = pi.zod;
	pi.registerTool({
		name: "refinement_preview",
		label: "Refinement Preview",
		description:
			"Prepare a session-scoped JSON preview for a refinement candidate. This never changes a project artifact or ledger; the interactive user must submit exactly aprobar before activation.",
		parameters: z.object({
			artifact: z.string(),
			candidate: z.string(),
			evidence: z.string(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as {
				artifact: string;
				candidate: string;
				evidence: string;
			};
			const preview = await runtime.preview({
				sessionId: ctx.sessionManager.getSessionId(),
				root: ctx.cwd,
				artifact: input.artifact,
				candidate: input.candidate,
				evidence: input.evidence,
			});
			return {
				content: [{ type: "text", text: renderPreview(preview) }],
				details: preview,
			};
		},
	});
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") {
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		if (event.text === CANCELLATION_WORD) {
			if (!runtime.discard(sessionId)) return;
			ctx.ui.notify("Pending refinement preview discarded.", "info");
			return { handled: true };
		}
		if (event.text !== APPROVAL_WORD) {
			return;
		}
		if (!runtime.hasPending(sessionId)) {
			return;
		}
		try {
			const active = await runtime.approve({ sessionId, root: ctx.cwd });
			ctx.ui.notify(`Refinement ${active.id} is active.`, "info");
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		}
		return { handled: true };
	});
	return runtime;
}
