import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function autonomyRuntimeRoot(
	projectRoot: string,
	runId: string,
	stateHome =
		process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
): string {
	if (runId.trim().length === 0 || /[^A-Za-z0-9._-]/.test(runId)) {
		throw new Error("Autonomy run ID contains unsafe path characters");
	}
	const projectKey = createHash("sha256")
		.update(resolve(projectRoot))
		.digest("hex")
		.slice(0, 24);
	return join(stateHome, "omp-pantheon", "autonomy", projectKey, runId);
}
