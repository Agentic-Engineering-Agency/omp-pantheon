/**
 * Slash commands that drive the loop runtime.
 *
 * These are *extension-registered* commands (not markdown drops) because
 * they need state I/O. The extension API delivers the user-facing prompt
 * through `pi.sendUserMessage` — `registerCommand` handlers don't return
 * prompts directly the way custom commands do.
 *
 * Available commands:
 *   /ralph-loop "<task>" [--completion-promise=TEXT] [--max-iterations=N] [--strategy=reset|continue]
 *   /ulw-loop   "<task>" [--completion-promise=TEXT] [--max-iterations=N] [--strategy=reset|continue]
 *   /cancel-ralph
 *   /stop-continuation
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type { LoopRuntime, StartLoopArgs } from "./runtime";

interface ParsedArgs {
	task: string;
	completionPromise?: string;
	maxIterations?: number;
	strategy?: "reset" | "continue";
}

/**
 * Parse `/ralph-loop` style argument strings:
 *   "task description" --completion-promise=DONE --max-iterations=50 --strategy=reset
 * Quoted task is optional — anything before the first `--` is treated as
 * the task description.
 */
function parseLoopArgs(raw: string): ParsedArgs {
	const trimmed = raw.trim();
	if (!trimmed) return { task: "" };

	// Split on whitespace but respect double-quoted segments.
	const tokens: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while (true) {
		m = re.exec(trimmed);
		if (m === null) break;
		tokens.push(m[1] ?? m[2]);
	}

	const taskParts: string[] = [];
	const args: ParsedArgs = { task: "" };
	for (const tok of tokens) {
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			const key = (eq === -1 ? tok : tok.slice(0, eq)).slice(2);
			const value = eq === -1 ? "true" : tok.slice(eq + 1);
			switch (key) {
				case "completion-promise":
					args.completionPromise = value;
					break;
				case "max-iterations": {
					const n = Number(value);
					if (Number.isFinite(n) && n > 0) args.maxIterations = Math.floor(n);
					break;
				}
				case "strategy":
					if (value === "reset" || value === "continue") args.strategy = value;
					break;
			}
		} else {
			taskParts.push(tok);
		}
	}
	args.task = taskParts.join(" ").trim();
	return args;
}

function buildKickoffPrompt(
	loopType: "Ralph" | "ULTRAWORK",
	args: StartLoopArgs,
): string {
	const lines: string[] = [];
	lines.push("<command-instruction>");
	lines.push(
		`You are starting a ${loopType} Loop — a self-referential development loop that runs until task completion.`,
	);
	lines.push("");
	lines.push("## How the loop works");
	lines.push("");
	lines.push("1. You will work on the task continuously.");
	if (loopType === "ULTRAWORK") {
		lines.push(
			`2. When you believe the work is complete, output: \`<promise>${args.completionPromise}</promise>\``,
		);
		lines.push(
			"3. That does NOT finish the loop yet. The system will require Oracle verification.",
		);
		lines.push(
			"4. The loop only ends after the system confirms Oracle verified the result.",
		);
		lines.push(`5. Maximum iterations: ${args.maxIterations ?? 32}.`);
	} else {
		lines.push(
			`2. When you believe the task is FULLY complete, output: \`<promise>${args.completionPromise}</promise>\``,
		);
		lines.push(
			"3. If you don't output the promise, the loop will automatically inject another prompt to continue.",
		);
		lines.push(`4. Maximum iterations: ${args.maxIterations ?? 100}.`);
	}
	lines.push("");
	lines.push("## Rules");
	lines.push("");
	lines.push("- Focus on completing the task fully, not partially.");
	lines.push(
		"- Do not output the completion promise until the task is truly done.",
	);
	lines.push(
		"- Each iteration should make meaningful progress toward the goal.",
	);
	lines.push("- If stuck, try different approaches.");
	lines.push("- Use todos to track your progress.");
	if (loopType === "ULTRAWORK") {
		lines.push(
			"- After you emit the completion promise, run Oracle verification when instructed.",
		);
		lines.push(
			"- Do not treat the promise as final completion until Oracle verifies it.",
		);
	}
	lines.push("");
	lines.push("## Exit conditions");
	lines.push("");
	if (loopType === "ULTRAWORK") {
		lines.push(
			"1. **Verified completion**: Oracle verifies the result and the system confirms it.",
		);
		lines.push("2. **Cancel**: User runs `/cancel-ralph`.");
	} else {
		lines.push(
			"1. **Completion**: Output your completion promise tag when fully complete.",
		);
		lines.push("2. **Max iterations**: Loop stops automatically at limit.");
		lines.push("3. **Cancel**: User runs `/cancel-ralph`.");
	}
	lines.push("</command-instruction>");
	lines.push("");
	lines.push("<user-task>");
	lines.push(args.task);
	lines.push("</user-task>");
	return lines.join("\n");
}

export function registerLoopCommands(
	pi: ExtensionAPI,
	runtime: LoopRuntime,
): void {
	pi.registerCommand("ralph-loop", {
		description:
			"Start a Ralph Loop — runs until completion promise or max-iterations",
		handler: async (rawArgs, ctx) => {
			const parsed = parseLoopArgs(rawArgs);
			if (!parsed.task) {
				ctx.ui.notify(
					'/ralph-loop requires a task: /ralph-loop "task description" [--completion-promise=DONE] [--max-iterations=100]',
					"error",
				);
				return;
			}
			const start: StartLoopArgs = {
				mode: "ralph",
				task: parsed.task,
				completionPromise: parsed.completionPromise,
				maxIterations: parsed.maxIterations,
				strategy: parsed.strategy,
			};
			await runtime.start(start);
			pi.sendUserMessage(buildKickoffPrompt("Ralph", start));
		},
	});

	pi.registerCommand("ulw-loop", {
		description:
			"Start an ULTRAWORK Loop — runs until Oracle-verified completion",
		handler: async (rawArgs, ctx) => {
			const parsed = parseLoopArgs(rawArgs);
			if (!parsed.task) {
				ctx.ui.notify(
					'/ulw-loop requires a task: /ulw-loop "task description" [--completion-promise=DONE] [--max-iterations=32]',
					"error",
				);
				return;
			}
			const start: StartLoopArgs = {
				mode: "ulw",
				task: parsed.task,
				completionPromise: parsed.completionPromise,
				maxIterations: parsed.maxIterations,
				strategy: parsed.strategy,
			};
			await runtime.start(start);
			pi.sendUserMessage(buildKickoffPrompt("ULTRAWORK", start));
		},
	});

	pi.registerCommand("cancel-ralph", {
		description: "Cancel the active Ralph or ULW loop",
		handler: async (_args, ctx) => {
			const { wasActive } = await runtime.cancel();
			ctx.ui.notify(
				wasActive
					? "Loop cancelled — state cleared."
					: "No active loop to cancel.",
				wasActive ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("stop-continuation", {
		description: "Stop loop / continuation mechanisms for this session",
		handler: async (_args, ctx) => {
			const { wasActive } = await runtime.cancel();
			ctx.ui.notify(
				wasActive
					? "Continuation stopped — loop state cleared."
					: "No active loop / continuation to stop.",
				"info",
			);
		},
	});
}
