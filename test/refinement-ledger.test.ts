import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
	RefinementLedger,
	RefinementLedgerError,
} from "../extensions/oh-my-omp/refinement/ledger";
const BASE_CONTENT = "original\n";
const CANDIDATE_CONTENT = "candidate\n";
const CANDIDATE_BYTES = Buffer.from(CANDIDATE_CONTENT);
const hashContent = (content: string): string =>
	`sha256:${createHash("sha256").update(content).digest("hex")}`;
const BASE_HASH = hashContent(BASE_CONTENT);
const CANDIDATE_HASH = hashContent(CANDIDATE_CONTENT);

const roots: string[] = [];

async function createLedger(options?: {
	afterCandidateInstall?: () => Promise<void> | void;
}) {
	const root = await mkdtemp(join(tmpdir(), "pantheon-refinement-"));
	roots.push(root);
	await mkdir(join(root, "skills", "review"), { recursive: true });
	await writeFile(join(root, "skills", "review", "SKILL.md"), BASE_CONTENT);
	let sequence = 0;
	const ledgerOptions = {
		now: () => `2026-08-11T12:00:0${sequence++}.000Z`,
		createId: () => `proposal-${sequence}`,
		...(options?.afterCandidateInstall
			? { afterCandidateInstall: options.afterCandidateInstall }
			: {}),
	};
	const ledger = new RefinementLedger(root, ledgerOptions);
	return { ledger, root };
}

async function propose(
	ledger: RefinementLedger,
	artifactPath = "skills/review/SKILL.md",
) {
	return ledger.propose({
		artifactPath,
		baseHash: BASE_HASH,
		contentHash: CANDIDATE_HASH,
		author: "agent:refiner",
		source: "evalfly:run-42",
	});
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("RefinementLedger", () => {
	test("records attributable lifecycle events and installs exact candidate bytes", async () => {
		const { ledger, root } = await createLedger();
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");
		const active = await ledger.activate(proposal.id, CANDIDATE_BYTES);

		expect(active).toMatchObject({
			status: "active",
			author: "agent:refiner",
			source: "evalfly:run-42",
			approvedBy: "user:sebastian",
			validationEvidence: ["evalfly:report-42"],
		});
		const lines = (
			await readFile(join(root, ".pi", "refinement", "ledger.jsonl"), "utf8")
		)
			.trim()
			.split("\n");
		expect(lines).toHaveLength(4);
		expect((await ledger.list())[0]).toEqual(active);
		expect(
			await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"),
		).toBe(CANDIDATE_CONTENT);
	});

	test("does not let validation approve or activation use stale content", async () => {
		const { ledger, root } = await createLedger();
		const artifactPath = join(root, "skills", "review", "SKILL.md");
		const proposal = await propose(ledger);
		const validated = await ledger.validate(proposal.id, "evalfly:report-42");

		expect(validated.status).toBe("validated");
		await expect(ledger.activate(proposal.id, CANDIDATE_BYTES)).rejects.toThrow(
			"approved",
		);
		await ledger.approve(proposal.id, "user:sebastian");
		await writeFile(artifactPath, "third-party edit\n");
		await expect(ledger.activate(proposal.id, CANDIDATE_BYTES)).rejects.toThrow(
			"base hash",
		);
		expect(await readFile(artifactPath, "utf8")).toBe("third-party edit\n");
	});

	test("rejects candidate bytes that do not match the proposed content hash", async () => {
		const { ledger, root } = await createLedger();
		const artifactPath = join(root, "skills", "review", "SKILL.md");
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");

		await expect(
			ledger.activate(proposal.id, Buffer.from("wrong\n")),
		).rejects.toThrow("candidate hash");
		expect(await readFile(artifactPath, "utf8")).toBe(BASE_CONTENT);
	});

	test("prevents conflicting active proposals for one artifact", async () => {
		const { ledger } = await createLedger();
		const first = await propose(ledger);
		await ledger.validate(first.id, "evalfly:first");
		await ledger.approve(first.id, "user:sebastian");
		await ledger.activate(first.id, CANDIDATE_BYTES);
		const second = await propose(ledger);
		await ledger.validate(second.id, "evalfly:second");
		await ledger.approve(second.id, "user:sebastian");

		await expect(ledger.activate(second.id, CANDIDATE_BYTES)).rejects.toThrow(
			"active proposal",
		);
	});

	test("serializes concurrent activation so one artifact has one active proposal", async () => {
		const { ledger } = await createLedger();
		const first = await propose(ledger);
		const second = await propose(ledger);
		for (const proposal of [first, second]) {
			await ledger.validate(proposal.id, `evalfly:${proposal.id}`);
			await ledger.approve(proposal.id, "user:sebastian");
		}

		const results = await Promise.allSettled([
			ledger.activate(first.id, CANDIDATE_BYTES),
			ledger.activate(second.id, CANDIDATE_BYTES),
		]);

		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(
			(await ledger.list()).filter((item) => item.status === "active"),
		).toHaveLength(1);
	});

	test("recovers activation interrupted after install without losing rollback snapshot", async () => {
		const interrupt = new Error("interrupt after candidate install");
		const { ledger, root } = await createLedger({
			afterCandidateInstall: () => {
				throw interrupt;
			},
		});
		const artifactPath = join(root, "skills", "review", "SKILL.md");
		await chmod(artifactPath, 0o764);
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");

		await expect(ledger.activate(proposal.id, CANDIDATE_BYTES)).rejects.toBe(
			interrupt,
		);
		expect(await readFile(artifactPath, "utf8")).toBe(CANDIDATE_CONTENT);
		expect((await ledger.list())[0]?.status).toBe("approved");

		const recoveredLedger = new RefinementLedger(root, {
			now: () => "2026-08-11T12:00:09.000Z",
		});
		const active = await recoveredLedger.activate(proposal.id, CANDIDATE_BYTES);
		expect(active.status).toBe("active");
		const rolledBack = await recoveredLedger.rollback(
			proposal.id,
			"regression after recovery",
		);
		expect(rolledBack.status).toBe("rolled_back");
		expect(await readFile(artifactPath, "utf8")).toBe(BASE_CONTENT);
		expect((await stat(artifactPath)).mode & 0o777).toBe(0o764);
	});

	test("restores the snapshotted artifact on rollback", async () => {
		const { ledger, root } = await createLedger();
		const artifactPath = join(root, "skills", "review", "SKILL.md");
		await chmod(artifactPath, 0o764);
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");
		await ledger.activate(proposal.id, CANDIDATE_BYTES);
		await chmod(artifactPath, 0o600);
		const rolledBack = await ledger.rollback(proposal.id, "regression");

		expect(rolledBack.status).toBe("rolled_back");
		expect(await readFile(artifactPath, "utf8")).toBe(BASE_CONTENT);
		expect((await stat(artifactPath)).mode & 0o777).toBe(0o764);
	});

	test("rejects traversal paths and invalid transitions", async () => {
		const { ledger } = await createLedger();
		await expect(
			ledger.propose({
				artifactPath: "../outside",
				baseHash: BASE_HASH,
				contentHash: CANDIDATE_HASH,
				author: "agent:refiner",
				source: "evalfly:run-42",
			}),
		).rejects.toBeInstanceOf(RefinementLedgerError);
		const proposal = await propose(ledger);
		await expect(ledger.approve(proposal.id, "user:sebastian")).rejects.toThrow(
			"validated",
		);
	});

	test("finishes rollback after artifact restoration but before ledger append", async () => {
		const { ledger, root } = await createLedger();
		const artifactPath = join(root, "skills", "review", "SKILL.md");
		await chmod(artifactPath, 0o764);
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");
		await ledger.activate(proposal.id, CANDIDATE_BYTES);
		await chmod(artifactPath, 0o600);

		const rolledBack = await ledger.rollback(proposal.id, "resume rollback");

		expect(rolledBack.status).toBe("rolled_back");
		expect(await readFile(artifactPath, "utf8")).toBe(BASE_CONTENT);
		expect((await stat(artifactPath)).mode & 0o777).toBe(0o764);
	});

	test("refuses rollback when active content drifted", async () => {
		const { ledger, root } = await createLedger();
		const artifactPath = join(root, "skills", "review", "SKILL.md");
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");
		await ledger.activate(proposal.id, CANDIDATE_BYTES);
		await writeFile(artifactPath, "third-party edit\n");

		await expect(ledger.rollback(proposal.id, "regression")).rejects.toThrow(
			"matches neither active nor base",
		);
		expect(await readFile(artifactPath, "utf8")).toBe("third-party edit\n");
	});

	test("quarantines a corrupted journal entry and fails closed", async () => {
		const { ledger, root } = await createLedger();
		await propose(ledger);
		const ledgerPath = join(root, ".pi", "refinement", "ledger.jsonl");
		await writeFile(
			ledgerPath,
			`${await readFile(ledgerPath, "utf8")}{bad json}\n`,
		);

		await expect(ledger.list()).rejects.toThrow("quarantined");
		const quarantine = await readFile(
			join(root, ".pi", "refinement", "quarantine.jsonl"),
			"utf8",
		);
		expect(quarantine).toContain("{bad json}");
	});
	test("refuses a symlinked project refinement state directory", async () => {
		const { ledger, root } = await createLedger();
		const outside = await mkdtemp(
			join(tmpdir(), "pantheon-refinement-outside-"),
		);
		roots.push(outside);
		await mkdir(join(root, ".pi"));
		await symlink(outside, join(root, ".pi", "refinement"), "dir");

		await expect(propose(ledger)).rejects.toThrow("symbolic link");
		expect(await Bun.file(join(outside, "ledger.jsonl")).exists()).toBe(false);
	});
});
