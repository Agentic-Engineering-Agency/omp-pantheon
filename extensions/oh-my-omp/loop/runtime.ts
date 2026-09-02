/**
 * Ralph / ULW loop runtime.
 *
 * Lifecycle (driven by `agent_end`):
 *
 *   ralph mode
 *   ----------
 *     iter N → emits <promise>TOKEN</promise> ⇒ terminate "completed"
 *     iter N → no promise                      ⇒ inject continuation prompt
 *     iter ≥ max                               ⇒ terminate "max-iter"
 *     state.paused                             ⇒ terminate "cancelled"
 *
 *   ulw mode
 *   --------
 *     iter N → emits promise (first time)      ⇒ inject Oracle verification prompt,
 *                                                set awaitingOracle = true
 *     awaitingOracle → next agent_end          ⇒ terminate "verified"
 *                      (Oracle's verdict is in the transcript; we trust the
 *                      orchestrator drove it)
 *     iter N → no promise                      ⇒ inject continuation prompt
 *     iter ≥ max (default 500)                 ⇒ terminate "max-iter"
 *
 * State lives at `<cwd>/.sisyphus/loop.json` (compatible with OMO).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentEndEvent } from "@oh-my-pi/pi-coding-agent";

import { detectPromise } from "./promise-detector";
import {
	type LoopMode,
	type LoopState,
	type LoopStrategy,
	clearLoopState,
	readLoopState,
	writeLoopState,
} from "./state";

export interface StartLoopArgs {
	mode: LoopMode;
	task: string;
	completionPromise?: string;
	maxIterations?: number;
	strategy?: LoopStrategy;
}

const DEFAULT_RALPH_MAX = 100;
const DEFAULT_ULW_MAX = 32;
const DEFAULT_PROMISE = "DONE";
/**
 * Consecutive continuation turns without a completion promise before the loop
 * escalates instead of injecting another "continue". A loop that keeps producing
 * "continue" turns without ever emitting the promise is a treadmill, not progress.
 */
const DEFAULT_STALL_LIMIT = 12;

export class LoopRuntime {
	private cwd: string;
	/** In-memory mirror of the persisted state. Re-read on attach. */
	private state: LoopState | null = null;

	constructor(private readonly pi: ExtensionAPI) {
		this.cwd = process.cwd();
	}

	async attach(ctx: ExtensionContext): Promise<void> {
		this.cwd = ctx.cwd;
		this.state = await readLoopState(this.cwd);
	}

	/** Called by the slash command handlers when the user starts a loop. */
	async start(args: StartLoopArgs): Promise<LoopState> {
		const max =
			args.maxIterations ??
			(args.mode === "ulw" ? DEFAULT_ULW_MAX : DEFAULT_RALPH_MAX);
		const next: LoopState = {
			mode: args.mode,
			task: args.task,
			completionPromise: args.completionPromise ?? DEFAULT_PROMISE,
			maxIterations: max,
			iter: 0,
			strategy: args.strategy ?? "continue",
			startedAt: new Date().toISOString(),
			stallCount: 0,
		};
		this.state = next;
		await writeLoopState(this.cwd, next);
		return next;
	}

	/** Called by `/cancel-ralph` and `/stop-continuation`. */
	async cancel(): Promise<{ wasActive: boolean }> {
		const was = this.state !== null;
		if (this.state) {
			this.state = { ...this.state, paused: true };
			await writeLoopState(this.cwd, this.state);
		}
		await clearLoopState(this.cwd);
		this.state = null;
		return { wasActive: was };
	}

	getState(): LoopState | null {
		return this.state;
	}

	/**
	 * Core loop tick. Inspect the just-finished agent turn and either:
	 *   - terminate the loop (clear state), or
	 *   - inject a continuation user message that drives the next iteration.
	 */
	async onAgentEnd(
		event: AgentEndEvent,
		_ctx: ExtensionContext,
	): Promise<void> {
		// Re-read in case another process / cancel command updated state mid-turn.
		this.state = await readLoopState(this.cwd);
		const state = this.state;
		if (!state) return;

		if (state.paused) {
			await this.terminate("cancelled");
			return;
		}

		const promised = detectPromise(event.messages, state.completionPromise);

		if (state.mode === "ralph") {
			if (promised) {
				await this.terminate("completed");
				return;
			}
			if (this.isStalled(state)) {
				await this.terminate("escalated");
				return;
			}
			if (state.iter + 1 >= state.maxIterations) {
				await this.terminate("max-iter");
				return;
			}
			await this.advance(state, this.ralphContinuationMessage(state));
			return;
		}

		// ULW
		if (state.awaitingOracle) {
			// We injected an oracle-verification prompt last turn. The agent's
			// most recent reply is the post-verification result.
			// We trust the orchestrator drove the verification; terminate.
			await this.terminate("verified");
			return;
		}
		if (promised) {
			// First promise — kick off oracle verification.
			const next = {
				...state,
				awaitingOracle: true,
				iter: state.iter + 1,
				stallCount: 0,
			};
			this.state = next;
			await writeLoopState(this.cwd, next);
			this.pi.sendUserMessage(this.ulwOracleVerificationMessage(state), {
				deliverAs: "followUp",
			});
			return;
		}
		if (this.isStalled(state)) {
			await this.terminate("escalated");
			return;
		}
		if (state.iter + 1 >= state.maxIterations) {
			await this.terminate("max-iter");
			return;
		}
		await this.advance(state, this.ulwContinuationMessage(state));
	}

	/**
	 * Detect a treadmill: too many consecutive continuation turns without a
	 * completion promise. Returns true when the loop should escalate instead of
	 * injecting another "continue".
	 */
	private isStalled(state: LoopState): boolean {
		const stallCount = state.stallCount ?? 0;
		return stallCount >= DEFAULT_STALL_LIMIT;
	}

	// ────────────────────────────────────────────────────────────────────────
	// helpers
	// ────────────────────────────────────────────────────────────────────────

	private async advance(state: LoopState, prompt: string): Promise<void> {
		const next = {
			...state,
			iter: state.iter + 1,
			stallCount: (state.stallCount ?? 0) + 1,
		};
		this.state = next;
		await writeLoopState(this.cwd, next);
		this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	private async terminate(
		reason: "completed" | "max-iter" | "cancelled" | "verified" | "escalated",
	): Promise<void> {
		await clearLoopState(this.cwd);
		this.state = null;
		const summary = (() => {
			switch (reason) {
				case "completed":
					return "Ralph loop completed: agent emitted the completion promise.";
				case "verified":
					return "ULW loop completed: Oracle verified the result.";
				case "max-iter":
					return "Loop terminated: maximum iterations reached.";
				case "cancelled":
					return "Loop cancelled by user.";
				case "escalated":
					return "Loop escalated: stalled without completion progress. State preserved — review and escalate to a human instead of continuing.";
			}
		})();
		this.pi.logger.info(summary);
	}

	private ralphContinuationMessage(state: LoopState): string {
		return [
			"<system-reminder>",
			`Ralph loop iteration ${state.iter + 1}/${state.maxIterations}.`,
			`Task: ${state.task}`,
			`Continue working toward completion. Emit \`<promise>${state.completionPromise}</promise>\` only when the task is fully done.`,
			"</system-reminder>",
		].join("\n");
	}

	private ulwContinuationMessage(state: LoopState): string {
		return [
			"<system-reminder>",
			`ULTRAWORK loop iteration ${state.iter + 1}/${state.maxIterations}.`,
			`Task: ${state.task}`,
			`Stay in ultrawork mode. Continue working toward verified completion. Emit \`<promise>${state.completionPromise}</promise>\` when you believe the work is finished — the system will then require Oracle verification before the loop ends.`,
			"</system-reminder>",
		].join("\n");
	}

	private ulwOracleVerificationMessage(state: LoopState): string {
		return [
			"<system-reminder>",
			`You emitted the completion promise \`<promise>${state.completionPromise}</promise>\`.`,
			"Before the loop terminates, you MUST request Oracle verification.",
			"",
			"Spawn the Oracle agent with the following task tool call:",
			"```",
			"task(",
			`  agent: "oracle",`,
			"  tasks: [{",
			`    id: "ulw-verify",`,
			`    description: "Verify ULW completion",`,
			`    assignment: "Verify the work for: ${state.task}\\n\\nReview the final state of the codebase: did the implementation actually deliver what the task asked for? Return APPROVE or REJECT with concrete reasons. If REJECT, list the specific issues that must be fixed."`,
			"  }]",
			")",
			"```",
			"",
			`Then summarise Oracle's verdict to the user. The loop will terminate after this turn.`,
			"</system-reminder>",
		].join("\n");
	}
}
