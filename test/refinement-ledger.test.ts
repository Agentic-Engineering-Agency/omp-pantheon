import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
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

const roots: string[] = [];

async function createLedger() {
	const root = await mkdtemp(join(tmpdir(), "pantheon-refinement-"));
	roots.push(root);
	let sequence = 0;
	const ledger = new RefinementLedger(root, {
		now: () => `2026-08-11T12:00:0${sequence++}.000Z`,
		createId: () => `proposal-${sequence}`,
	});
	return { ledger, root };
}

async function propose(
	ledger: RefinementLedger,
	artifactPath = "skills/review/SKILL.md",
) {
	return ledger.propose({
		artifactPath,
		baseHash: "sha256:base",
		contentHash: "sha256:candidate",
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
	test("records attributable append-only lifecycle events", async () => {
		const { ledger, root } = await createLedger();
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");
		const active = await ledger.activate(proposal.id, "sha256:base");

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
	});

	test("does not let validation approve or activation use stale content", async () => {
		const { ledger } = await createLedger();
		const proposal = await propose(ledger);
		const validated = await ledger.validate(proposal.id, "evalfly:report-42");

		expect(validated.status).toBe("validated");
		await expect(ledger.activate(proposal.id, "sha256:base")).rejects.toThrow(
			"approved",
		);
		await ledger.approve(proposal.id, "user:sebastian");
		await expect(
			ledger.activate(proposal.id, "sha256:changed"),
		).rejects.toThrow("base hash");
	});

	test("prevents conflicting active proposals for one artifact", async () => {
		const { ledger } = await createLedger();
		const first = await propose(ledger);
		await ledger.validate(first.id, "evalfly:first");
		await ledger.approve(first.id, "user:sebastian");
		await ledger.activate(first.id, "sha256:base");
		const second = await propose(ledger);
		await ledger.validate(second.id, "evalfly:second");
		await ledger.approve(second.id, "user:sebastian");

		await expect(ledger.activate(second.id, "sha256:base")).rejects.toThrow(
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
			ledger.activate(first.id, "sha256:base"),
			ledger.activate(second.id, "sha256:base"),
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

	test("records rollback without mutating the artifact", async () => {
		const { ledger, root } = await createLedger();
		const artifactPath = join(root, "skills", "review", "SKILL.md");
		await Bun.write(artifactPath, "original\n");
		const proposal = await propose(ledger);
		await ledger.validate(proposal.id, "evalfly:report-42");
		await ledger.approve(proposal.id, "user:sebastian");
		await ledger.activate(proposal.id, "sha256:base");
		const rolledBack = await ledger.rollback(proposal.id, "regression");

		expect(rolledBack.status).toBe("rolled_back");
		expect(await readFile(artifactPath, "utf8")).toBe("original\n");
	});

	test("rejects traversal paths and invalid transitions", async () => {
		const { ledger } = await createLedger();
		await expect(
			ledger.propose({
				artifactPath: "../outside",
				baseHash: "sha256:base",
				contentHash: "sha256:candidate",
				author: "agent:refiner",
				source: "evalfly:run-42",
			}),
		).rejects.toBeInstanceOf(RefinementLedgerError);
		const proposal = await propose(ledger);
		await expect(ledger.approve(proposal.id, "user:sebastian")).rejects.toThrow(
			"validated",
		);
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
