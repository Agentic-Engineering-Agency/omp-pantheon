import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import { type AgentdStatus, AutonomyAgentd } from "./agentd";
import { registerAutonomyCommands } from "./commands";
import { AutonomyController, AutonomyTransitionError } from "./controller";
import { AutonomyStore } from "./store";
import type { AutonomyRun } from "./types";

interface NativeGoalUpdatedEvent {
	goal: {
		id: string;
		objective: string;
		status: string;
	} | null;
}

const ACTIVE_STATUSES: Partial<Record<AutonomyRun["status"], true>> = {
	running: true,
	waiting: true,
};

export interface VerificationReceipt {
	status: "pass" | "fail";
	evidence: string;
}

export interface VerificationRunner {
	verify(
		cwd: string,
		command: string,
		signal?: AbortSignal,
	): Promise<VerificationReceipt>;
}

const defaultVerificationRunner: VerificationRunner = {
	async verify(cwd, command, signal) {
		const child = Bun.spawn({
			cmd: [process.env.SHELL ?? "/bin/sh", "-lc", command],
			cwd,
			stdout: "ignore",
			stderr: "ignore",
		});
		const abort = (): void => child.kill("SIGKILL");
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const exitCode = await child.exited;
			return {
				status: exitCode === 0 ? "pass" : "fail",
				evidence: `command:${command}:exit:${exitCode}`,
			};
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	},
};

export class AutonomyRuntime {
	private controller: AutonomyController | null = null;
	private agentd: AutonomyAgentd | null = null;
	private cwd: string | null = null;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly verifier: VerificationRunner = defaultVerificationRunner,
	) {}

	async attach(
		ctx: Pick<ExtensionContext, "cwd"> &
			Partial<Pick<ExtensionContext, "sessionManager">>,
	): Promise<void> {
		if (this.cwd === ctx.cwd && this.controller !== null) return;
		this.agentd?.close();
		this.cwd = ctx.cwd;
		this.controller = new AutonomyController(new AutonomyStore(ctx.cwd));
		this.agentd = "sessionManager" in ctx ? new AutonomyAgentd(ctx.cwd) : null;
	}

	async start(
		task: string,
		maxAttempts: number,
		verificationCommand: string,
	): Promise<AutonomyRun> {
		const state = await (await this.requireController()).start({
			task,
			maxAttempts,
			verificationCommand,
			gates: [
				{ id: "native-goal", label: "OMP native goal" },
				{ id: "verification", label: "Trusted verification command" },
			],
		});
		await this.agentd?.start(state.id);
		return state;
	}

	async get(): Promise<AutonomyRun | null> {
		return (await this.requireController()).get();
	}
	async getWorkerStatus(): Promise<AgentdStatus | null> {
		if (!this.agentd) return null;
		const state = await (await this.requireController()).get();
		if (state === null) return null;
		try {
			return await this.agentd.status(state.id);
		} catch {
			return { state: "stopped", restartCount: 0 };
		}
	}

	async pause(): Promise<AutonomyRun> {
		return (await this.requireController()).pause();
	}

	async resume(): Promise<AutonomyRun> {
		return (await this.requireController()).resume();
	}

	async cancel(): Promise<AutonomyRun> {
		const state = await (await this.requireController()).cancel();
		await this.stopAgentd(state.id);
		return state;
	}

	async runVerification(signal?: AbortSignal): Promise<AutonomyRun> {
		const controller = await this.requireController();
		const state = await controller.get();
		if (state === null) {
			throw new AutonomyTransitionError("No autonomy run exists");
		}
		const receipt = await this.verifier.verify(
			this.cwd ?? "",
			state.verificationCommand,
			signal,
		);
		return controller.recordGate({
			gateId: "verification",
			status: receipt.status,
			evidence: receipt.evidence,
			reporter: "host-verifier",
			attempt: state.attempt,
			artifactRevision: state.artifactRevision,
		});
	}

	async onGoalUpdated(event: NativeGoalUpdatedEvent): Promise<void> {
		if (event.goal === null) return;
		const controller = await this.requireController();
		const state = await controller.get();
		if (
			state === null ||
			ACTIVE_STATUSES[state.status] !== true ||
			!state.gates.some((gate) => gate.id === "native-goal")
		) {
			return;
		}
		if (state.nativeGoalId === undefined) {
			if (
				event.goal.status === "active" &&
				event.goal.objective.trim() === state.task
			) {
				await controller.bindNativeGoal({
					id: event.goal.id,
					objective: event.goal.objective,
				});
			}
			return;
		}
		if (
			event.goal.id !== state.nativeGoalId ||
			event.goal.status !== "complete"
		) {
			return;
		}
		await controller.recordGate({
			gateId: "native-goal",
			status: "pass",
			evidence: `goal:${event.goal.id}:complete`,
			reporter: "native-goal-event",
			attempt: state.attempt,
			artifactRevision: state.artifactRevision,
		});
	}

	async onAgentEnd(_event: AgentEndEvent): Promise<void> {
		const controller = await this.requireController();
		const state = await controller.get();
		if (state === null || ACTIVE_STATUSES[state.status] !== true) return;

		const decision = await controller.evaluateCompletion();
		if (decision.completed) {
			this.pi.logger.info(
				"Autonomy run succeeded after objective gates passed",
			);
			await this.stopAgentd(state.id);
			return;
		}
		const continuation = await controller.continueAfterIncomplete();
		if (continuation.failed) {
			this.pi.logger.warn("Autonomy run failed at its maximum attempt bound");
			await this.stopAgentd(state.id);
			return;
		}
		this.pi.sendUserMessage(
			[
				"<system-reminder>",
				`Verified autonomy continues. Missing gates: ${decision.pendingGateIds.join(", ")}.`,
				"Produce current objective evidence; completion promises and prose do not satisfy gates.",
				"</system-reminder>",
			].join("\n"),
			{ deliverAs: "followUp" },
		);
	}

	async close(): Promise<void> {
		await this.stopAgentd();
		this.agentd?.close();
		this.agentd = null;
	}

	private async stopAgentd(runId?: string): Promise<void> {
		if (!this.agentd) return;
		const resolvedRunId =
			runId ?? (await (await this.requireController()).get())?.id;
		if (resolvedRunId === undefined) return;
		try {
			await this.agentd.stop(resolvedRunId);
		} catch {
			this.pi.logger.debug("Autonomy worker was already stopped");
		}
	}

	private async requireController(): Promise<AutonomyController> {
		if (this.controller === null) {
			throw new AutonomyTransitionError(
				"Autonomy runtime is not attached to a project",
			);
		}
		return this.controller;
	}
}

export function registerAutonomy(
	pi: ExtensionAPI,
	verifier: VerificationRunner = defaultVerificationRunner,
): AutonomyRuntime {
	const runtime = new AutonomyRuntime(pi, verifier);
	pi.on("session_start", (_event, ctx) => runtime.attach(ctx));
	pi.on("session_switch", (_event, ctx) => runtime.attach(ctx));
	pi.on("session_branch", (_event, ctx) => runtime.attach(ctx));
	pi.on("goal_updated", (event) => runtime.onGoalUpdated(event));
	pi.on("agent_end", (event) => runtime.onAgentEnd(event));
	pi.on("session_shutdown", () => runtime.close());
	registerAutonomyCommands(pi, runtime);

	const z = pi.zod;
	pi.registerTool({
		name: "autonomy_gate",
		label: "Autonomy Verification",
		description:
			"Run the user-configured verification command and record its host-observed exit status; native goal completion is event-owned",
		parameters: z.object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			await runtime.attach(ctx);
			const state = await runtime.runVerification(signal);
			const gate = state.gates.find(
				(candidate) => candidate.id === "verification",
			);
			return {
				content: [
					{
						type: "text",
						text: `Trusted verification ${gate?.status ?? "unknown"} recorded for attempt ${state.attempt}, artifact ${state.artifactRevision}.`,
					},
				],
				details: {
					runId: state.id,
					gateId: "verification",
					status: gate?.status,
					attempt: state.attempt,
					artifactRevision: state.artifactRevision,
				},
			};
		},
	});
	return runtime;
}
