/**
 * oh-my-omp — port of oh-my-openagent (OMO) to oh-my-pi (OMP).
 *
 * Responsibilities:
 *   - Advertise the bundled skills directory via `resources_discover`.
 *   - Register opt-in, gate-verified autonomy backed by native OMP goals.
 *   - Register lifecycle hooks for EvalFly, todos, comments, and intent.
 *   - Markdown commands, agents, and skills ship as files discovered by OMP.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { registerAutonomy } from "./autonomy/runtime";
import { registerEvalFlyEnforcementGate } from "./evalfly/enforcement-gate";
import { registerEvalFlyTraceCapture } from "./evalfly/trace-buffer";
import { registerCommentChecker } from "./hooks/comment-checker";
import { registerEvalFlyAdvisor } from "./hooks/evalfly-advisor";
import { registerIntentGate } from "./hooks/intent-gate";
import { registerTodoEnforcer } from "./hooks/todo-enforcer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(HERE, "../../skills");
const VERSION = "0.2.0";

export default async function (pi: ExtensionAPI): Promise<void> {
	// Advertise our bundled skill bundle. OMP normally only scans
	// ~/.omp/agent/skills/, but doing this through the event keeps the
	// extension self-contained and forward-compatible if the layout ever
	// changes.
	pi.on("resources_discover", () => ({
		skillPaths: [SKILLS_DIR],
	}));

	pi.on("session_start", () => {
		pi.logger.debug("oh-my-omp loaded", {
			version: VERSION,
			skills: SKILLS_DIR,
		});
	});

	// Verified autonomy: no state means no autonomous behavior.
	registerAutonomy(pi);

	// Lifecycle hooks: advisory context plus discipline enforcement.
	registerEvalFlyEnforcementGate(pi);
	registerEvalFlyTraceCapture(pi);
	registerEvalFlyAdvisor(pi);
	registerTodoEnforcer(pi);
	registerCommentChecker(pi);
	registerIntentGate(pi);
}
