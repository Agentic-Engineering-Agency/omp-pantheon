import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rm, stat } from "node:fs/promises";

import { Database } from "bun:sqlite";

interface LockMetadata {
	token: string;
	pid: number;
	acquiredAt: string;
}

export interface FileLockOptions {
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
	now?: () => number;
}

export class FileLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileLockError";
	}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function databaseIsLocked(error: unknown): boolean {
	const code =
		error !== null && typeof error === "object" && "code" in error
			? error.code
			: undefined;
	return (
		code === "SQLITE_BUSY" ||
		(error instanceof Error && /database is locked/i.test(error.message))
	);
}

function releaseGuard(database: Database): void {
	try {
		database.exec("ROLLBACK");
	} finally {
		database.close();
	}
}

async function acquireGuard(path: string): Promise<Database | null> {
	const database = new Database(`${path}.guard.sqlite`, {
		create: true,
		strict: true,
	});
	try {
		database.exec("PRAGMA busy_timeout = 0");
		database.exec("BEGIN IMMEDIATE");
		await chmod(`${path}.guard.sqlite`, 0o600);
		return database;
	} catch (error) {
		database.close();
		if (databaseIsLocked(error)) return null;
		throw error;
	}
}

async function existingLockIsStale(
	path: string,
	staleMs: number,
	now: () => number,
): Promise<boolean> {
	let ageMs: number;
	let ownerPid: number | null = null;
	try {
		const [raw, metadata] = await Promise.all([
			readFile(path, "utf8"),
			stat(path),
		]);
		ageMs = now() - metadata.mtimeMs;
		try {
			const parsed = JSON.parse(raw) as Partial<LockMetadata>;
			if (typeof parsed.acquiredAt === "string") {
				const acquiredAt = Date.parse(parsed.acquiredAt);
				if (Number.isFinite(acquiredAt)) ageMs = now() - acquiredAt;
			}
			if (typeof parsed.pid === "number") ownerPid = parsed.pid;
		} catch {
			// Invalid metadata can be reclaimed only after the filesystem age is stale.
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	return ageMs >= staleMs && (ownerPid === null || !processIsAlive(ownerPid));
}

async function createLockFile(
	path: string,
	metadata: LockMetadata,
): Promise<void> {
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(metadata), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function acquireFileLock(
	path: string,
	options: FileLockOptions = {},
): Promise<() => Promise<void>> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const staleMs = options.staleMs ?? 30_000;
	const retryMs = options.retryMs ?? 10;
	const now = options.now ?? Date.now;
	const deadline = now() + timeoutMs;
	const token = randomUUID();
	while (true) {
		const guard = await acquireGuard(path);
		if (guard !== null) {
			try {
				await rm(`${path}.breaker`, { force: true });
				try {
					const metadata: LockMetadata = {
						token,
						pid: process.pid,
						acquiredAt: new Date(now()).toISOString(),
					};
					await createLockFile(path, metadata);
					let released = false;
					return async () => {
						if (released) return;
						released = true;
						try {
							const current = JSON.parse(
								await readFile(path, "utf8"),
							) as Partial<LockMetadata>;
							if (current.token === token) await rm(path, { force: true });
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						} finally {
							releaseGuard(guard);
						}
					};
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				if (await existingLockIsStale(path, staleMs, now)) {
					await rm(path, { force: true });
					releaseGuard(guard);
					continue;
				}
			} catch (error) {
				releaseGuard(guard);
				throw error;
			}
			releaseGuard(guard);
		}
		if (now() >= deadline) {
			throw new FileLockError(`Timed out acquiring lock ${path}`);
		}
		await Bun.sleep(retryMs);
	}
}
