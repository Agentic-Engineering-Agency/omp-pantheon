/**
 * Detects the Ralph/ULW completion promise tag inside a finished agent turn.
 *
 * The continuation prompts built in `runtime.ts` (`ralphContinuationMessage`,
 * `ulwContinuationMessage`, `ulwOracleVerificationMessage`) all instruct the
 * agent to emit `<promise>TOKEN</promise>` verbatim, in its own assistant
 * text, only once it believes the task is complete. This scans every
 * assistant message's text blocks in the turn for that tag and reports
 * whether any captured token matches `completionPromise` (compared after
 * trimming surrounding whitespace on both sides).
 */
import type { AgentEndEvent } from "@oh-my-pi/pi-coding-agent";

type TurnMessages = AgentEndEvent["messages"];

const PROMISE_TAG = /<promise>([\s\S]*?)<\/promise>/gi;

/**
 * @param messages - the turn's messages, as delivered on `agent_end`.
 * @param completionPromise - the exact token the loop is waiting for
 *   (`LoopState.completionPromise`, e.g. the default `"DONE"`).
 * @returns true if any assistant message in this turn contains
 *   `<promise>completionPromise</promise>`.
 */
export function detectPromise(
	messages: TurnMessages,
	completionPromise: string,
): boolean {
	const expected = completionPromise.trim();

	for (const message of messages) {
		const candidate = message as { role?: string; content?: unknown };
		if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) {
			continue;
		}

		for (const block of candidate.content as Array<{
			type?: string;
			text?: string;
		}>) {
			if (block?.type !== "text" || typeof block.text !== "string") continue;

			PROMISE_TAG.lastIndex = 0;
			let match: RegExpExecArray | null;
			// biome-ignore lint/suspicious/noAssignInExpressions: exec() loop idiom
			while ((match = PROMISE_TAG.exec(block.text))) {
				if (match[1].trim() === expected) return true;
			}
		}
	}

	return false;
}
