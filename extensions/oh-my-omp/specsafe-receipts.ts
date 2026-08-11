import { createHash, randomUUID } from "node:crypto";
import {
	type Stats,
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	preparePrivateProjectAreaRootSync,
	privateProjectAreaRoot,
} from "./private-state";

export interface SpecSafeClosureReceipt {
	sliceId: string;
	beganAt: string;
	endedAt: string;
	outcome: "PASS" | "FAIL" | "ABANDONED";
}

interface PersistedSpecSafeClosureReceipt extends SpecSafeClosureReceipt {
	schemaVersion: 1;
	checksum: string;
}

function checksum(
	receipt: SpecSafeClosureReceipt & { schemaVersion: 1 },
): string {
	return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

function requireTimestamp(value: string, label: string): void {
	if (value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${label} must be a valid timestamp`);
	}
}

function validateReceipt(receipt: SpecSafeClosureReceipt): void {
	if (receipt.sliceId.trim().length === 0) {
		throw new Error("SpecSafe receipt slice ID must be non-empty");
	}
	requireTimestamp(receipt.beganAt, "SpecSafe receipt beganAt");
	requireTimestamp(receipt.endedAt, "SpecSafe receipt endedAt");
	if (Date.parse(receipt.endedAt) < Date.parse(receipt.beganAt)) {
		throw new Error("SpecSafe receipt cannot end before it begins");
	}
	if (
		receipt.outcome !== "PASS" &&
		receipt.outcome !== "FAIL" &&
		receipt.outcome !== "ABANDONED"
	) {
		throw new Error("SpecSafe receipt outcome is invalid");
	}
}

function receiptKey(sliceId: string, beganAt: string): string {
	return createHash("sha256")
		.update(JSON.stringify({ sliceId, beganAt }))
		.digest("hex");
}

function receiptDirectory(projectRoot: string, stateHome?: string): string {
	return join(
		privateProjectAreaRoot(projectRoot, "specsafe", stateHome),
		"closures",
	);
}

function receiptPath(
	projectRoot: string,
	sliceId: string,
	beganAt: string,
	stateHome?: string,
): string {
	return join(
		receiptDirectory(projectRoot, stateHome),
		`${receiptKey(sliceId, beganAt)}.json`,
	);
}

const RECEIPT_TEMP_FILE = /^\.[0-9a-f-]{36}\.tmp$/;

function recoverInterruptedTempLink(
	target: string,
	targetMetadata: Stats,
): void {
	if (targetMetadata.nlink === 1) return;
	for (const name of readdirSync(dirname(target))) {
		if (!RECEIPT_TEMP_FILE.test(name)) continue;
		const candidate = join(dirname(target), name);
		const candidateMetadata = lstatSync(candidate);
		if (
			!candidateMetadata.isSymbolicLink() &&
			candidateMetadata.isFile() &&
			candidateMetadata.dev === targetMetadata.dev &&
			candidateMetadata.ino === targetMetadata.ino
		) {
			unlinkSync(candidate);
		}
	}
}

function parsePersistedReceipt(
	path: string,
	expectedSliceId: string,
	expectedBeganAt: string,
): SpecSafeClosureReceipt {
	let metadata = lstatSync(path);
	if (metadata.isSymbolicLink() || !metadata.isFile()) {
		throw new Error(`Unsafe SpecSafe receipt file: ${path}`);
	}
	recoverInterruptedTempLink(path, metadata);
	metadata = lstatSync(path);
	if (metadata.nlink !== 1) {
		throw new Error(`Unsafe SpecSafe receipt file: ${path}`);
	}
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("schemaVersion" in parsed) ||
		parsed.schemaVersion !== 1 ||
		!("sliceId" in parsed) ||
		typeof parsed.sliceId !== "string" ||
		!("beganAt" in parsed) ||
		typeof parsed.beganAt !== "string" ||
		!("endedAt" in parsed) ||
		typeof parsed.endedAt !== "string" ||
		!("outcome" in parsed) ||
		typeof parsed.outcome !== "string" ||
		!("checksum" in parsed) ||
		typeof parsed.checksum !== "string"
	) {
		throw new Error(`Malformed SpecSafe receipt: ${path}`);
	}
	const receipt: SpecSafeClosureReceipt = {
		sliceId: parsed.sliceId,
		beganAt: parsed.beganAt,
		endedAt: parsed.endedAt,
		outcome: parsed.outcome as SpecSafeClosureReceipt["outcome"],
	};
	validateReceipt(receipt);
	const payload = { schemaVersion: 1 as const, ...receipt };
	if (
		parsed.checksum !== checksum(payload) ||
		receipt.sliceId !== expectedSliceId ||
		receipt.beganAt !== expectedBeganAt
	) {
		throw new Error(`SpecSafe receipt does not match its instance: ${path}`);
	}
	return receipt;
}

export function writeSpecSafeClosureReceipt(
	projectRoot: string,
	receipt: SpecSafeClosureReceipt,
	stateHome?: string,
): void {
	validateReceipt(receipt);
	const projectStateRoot = preparePrivateProjectAreaRootSync(
		projectRoot,
		"specsafe",
		stateHome,
	);
	const directory = join(projectStateRoot, "closures");
	const directoryMetadata = existsSync(directory) ? lstatSync(directory) : null;
	if (directoryMetadata === null) {
		mkdirSync(directory, { mode: 0o700 });
	} else if (
		directoryMetadata.isSymbolicLink() ||
		!directoryMetadata.isDirectory()
	) {
		throw new Error(`Unsafe SpecSafe receipt directory: ${directory}`);
	}
	chmodSync(directory, 0o700);
	const target = receiptPath(
		projectRoot,
		receipt.sliceId,
		receipt.beganAt,
		stateHome,
	);
	if (existsSync(target)) {
		const existing = parsePersistedReceipt(
			target,
			receipt.sliceId,
			receipt.beganAt,
		);
		if (JSON.stringify(existing) === JSON.stringify(receipt)) return;
		throw new Error(
			"SpecSafe closure receipt already exists with different evidence",
		);
	}
	const payload = { schemaVersion: 1 as const, ...receipt };
	const persisted: PersistedSpecSafeClosureReceipt = {
		...payload,
		checksum: checksum(payload),
	};
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	try {
		linkSync(temporary, target);
		chmodSync(target, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = parsePersistedReceipt(
			target,
			receipt.sliceId,
			receipt.beganAt,
		);
		if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
			throw new Error(
				"SpecSafe closure receipt already exists with different evidence",
			);
		}
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}
export function readSpecSafeClosureReceipt(
	projectRoot: string,
	sliceId: string,
	beganAt: string,
	stateHome?: string,
): SpecSafeClosureReceipt | null {
	const directory = receiptDirectory(projectRoot, stateHome);
	const target = receiptPath(projectRoot, sliceId, beganAt, stateHome);
	if (!existsSync(target)) return null;
	const realDirectory = realpathSync(directory);
	const realTarget = realpathSync(target);
	const relativeTarget = relative(realDirectory, realTarget);
	if (
		isAbsolute(relativeTarget) ||
		relativeTarget === ".." ||
		relativeTarget.startsWith(`..${sep}`)
	) {
		throw new Error("SpecSafe receipt escapes its private directory");
	}
	return parsePersistedReceipt(target, sliceId, beganAt);
}
