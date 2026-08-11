import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type { AutonomyRuntime } from "./runtime";

interface ParsedAutonomyCommand {
	action: "start" | "status" | "pause" | "resume" | "cancel" | "explain";
	task?: string;
	maxAttempts?: number;
}

function parseAutonomyCommand(raw: string): ParsedAutonomyCommand | null {
	const tokens: string[] = [];
	const trimmed = raw.trim();
	const matcher = /"([^"]*)"|(\S+)/g;
	for (
		let match = matcher.exec(trimmed);
		match !== null;
		match = matcher.exec(trimmed)
	) {
		const token = match[1] ?? match[2];
		if (token !== undefined) tokens.push(token);
	}
	const action = tokens.shift() ?? "status";
	if (
		!["start", "status", "pause", "resume", "cancel", "explain"].includes(
			action,
		)
	) {
		return null;
	}

	const parsed: ParsedAutonomyCommand = {
		action: action as ParsedAutonomyCommand["action"],
	};
	if (action !== "start") return parsed;

	const taskParts: string[] = [];
	for (const token of tokens) {
		if (token.startsWith("--max-attempts=")) {
			const maxAttempts = Number(token.slice("--max-attempts=".length));
			if (Number.isInteger(maxAttempts) && maxAttempts > 0) {
				parsed.maxAttempts = maxAttempts;
			}
			continue;
		}
		taskParts.push(token);
	}
	parsed.task = taskParts.join(" ").trim();
	return parsed;
}

export function registerAutonomyCommands(
	pi: ExtensionAPI,
	runtime: AutonomyRuntime,
): void {
	pi.registerCommand("autonomy", {
		description:
			"Control opt-in verified autonomy: start, status, pause, resume, cancel, explain",
		handler: async (rawArgs, ctx) => {
			await runtime.attach(ctx);
			const parsed = parseAutonomyCommand(rawArgs);
			if (parsed === null) {
				ctx.ui.notify(
					"Usage: /autonomy start <task> [--max-attempts=N] | status | pause | resume | cancel | explain",
					"error",
				);
				return;
			}
			try {
				switch (parsed.action) {
					case "start": {
						if (!parsed.task) {
							ctx.ui.notify("/autonomy start requires a task", "error");
							return;
						}
						const state = await runtime.start(
							parsed.task,
							parsed.maxAttempts ?? 25,
						);
						pi.sendUserMessage(
							[
								"<system-reminder>",
								`Verified autonomy started for: ${state.task}`,
								"Create and maintain a native OMP goal for this objective.",
								"Completion requires the native-goal and verification gates to pass for the same attempt and artifact revision.",
								"Record concrete verification with the autonomy_gate tool. Agent prose and completion promises are ignored.",
								"</system-reminder>",
							].join("\n"),
						);
						return;
					}
					case "status": {
						const [state, worker] = await Promise.all([
							runtime.get(),
							runtime.getWorkerStatus(),
						]);
						ctx.ui.notify(
							state === null
								? "No autonomy run exists."
								: `Autonomy ${state.status}; attempt ${state.attempt}/${state.maxAttempts}; artifact ${state.artifactRevision}; gates ${state.gates.map((gate) => `${gate.id}=${gate.status}`).join(", ")}; worker ${worker?.state ?? "unsupported"}`,
							state === null ? "warning" : "info",
						);
						return;
					}
					case "pause":
						await runtime.pause();
						ctx.ui.notify("Autonomy paused.", "info");
						return;
					case "resume":
						await runtime.resume();
						ctx.ui.notify("Autonomy resumed.", "info");
						return;
					case "cancel":
						await runtime.cancel();
						ctx.ui.notify("Autonomy cancelled.", "info");
						return;
					case "explain":
						ctx.ui.notify(
							"Pantheon autonomy reuses native OMP goals and continues until every objective gate has current evidence. It never trusts completion prose.",
							"info",
						);
						return;
				}
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
