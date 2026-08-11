import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";

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

async function breakStaleLock(
	path: string,
	staleMs: number,
	now: () => number,
): Promise<boolean> {
	let ageMs: number;
	let ownerPid: number | null = null;
	try {
		const [raw, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
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
	if (ageMs < staleMs || (ownerPid !== null && processIsAlive(ownerPid))) {
		return false;
	}
	const stalePath = `${path}.stale-${randomUUID()}`;
	try {
		await rename(path, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
	await rm(stalePath, { force: true });
	return true;
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
		try {
			const handle = await open(path, "wx", 0o600);
			const metadata: LockMetadata = {
				token,
				pid: process.pid,
				acquiredAt: new Date(now()).toISOString(),
			};
			await handle.writeFile(JSON.stringify(metadata), "utf8");
			await handle.sync();
			await handle.close();
			return async () => {
				try {
					const current = JSON.parse(
						await readFile(path, "utf8"),
					) as Partial<LockMetadata>;
					if (current.token === token) await rm(path, { force: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (await breakStaleLock(path, staleMs, now)) continue;
		if (now() >= deadline) {
			throw new FileLockError(`Timed out acquiring lock ${path}`);
		}
		await Bun.sleep(retryMs);
	}
}
