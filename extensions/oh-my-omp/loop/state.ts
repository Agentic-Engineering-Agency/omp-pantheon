/**
 * Loop state persistence.
 *
 * The Ralph / ULW loops survive across turns and (within a project) across
 * sessions. We persist to `.sisyphus/loop.json` under the current working
 * directory — the same location OMO uses, so a project that has been
 * driven by OMO and is now driven by OMP keeps its boulder.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type LoopMode = "ralph" | "ulw";

export type LoopStrategy = "reset" | "continue";

/**
 * Persisted loop state. `paused` is the cancel signal — `cancel-ralph`
 * sets it and the next `agent_end` clears the file.
 */
export interface LoopState {
	mode: LoopMode;
	task: string;
	completionPromise: string;
	maxIterations: number;
	iter: number;
	strategy: LoopStrategy;
	startedAt: string;
	/** ULW only: true once the agent emitted the promise tag and Oracle is being asked to verify. */
	awaitingOracle?: boolean;
	/** Cancellation flag set by /cancel-ralph or /stop-continuation. */
	paused?: boolean;
	/**
	 * Consecutive continuation turns without a completion promise. Persisted so it
	 * survives context loss and session restarts; the loop runtime escalates
	 * instead of injecting "continue" once this exceeds the stall limit.
	 */
	stallCount?: number;
}

const STATE_DIR_NAME = ".sisyphus";
const STATE_FILE_NAME = "loop.json";

function statePath(cwd: string): string {
	return path.join(cwd, STATE_DIR_NAME, STATE_FILE_NAME);
}

export async function readLoopState(cwd: string): Promise<LoopState | null> {
	try {
		const raw = await fs.readFile(statePath(cwd), "utf-8");
		const parsed = JSON.parse(raw) as LoopState;
		if (!parsed.mode || typeof parsed.iter !== "number") return null;
		return parsed;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export async function writeLoopState(
	cwd: string,
	state: LoopState,
): Promise<void> {
	const file = statePath(cwd);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(state, null, 2), "utf-8");
}

export async function clearLoopState(cwd: string): Promise<void> {
	try {
		await fs.unlink(statePath(cwd));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
}
