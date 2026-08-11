import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import { registerAutonomyCommands } from "./commands";
import { AutonomyController, AutonomyTransitionError } from "./controller";
import { AutonomyStore } from "./store";
import type { AutonomyRun } from "./types";

interface NativeGoalUpdatedEvent {
	goal: {
		id: string;
		status: string;
	} | null;
}

const ACTIVE_STATUSES: Partial<Record<AutonomyRun["status"], true>> = {
	running: true,
	waiting: true,
};

function parseGateEvidence(params: unknown): {
	gateId: string;
	status: "pass" | "fail";
	evidence: string;
} {
	if (
		typeof params !== "object" ||
		params === null ||
		!("gateId" in params) ||
		typeof params.gateId !== "string" ||
		!("status" in params) ||
		(params.status !== "pass" && params.status !== "fail") ||
		!("evidence" in params) ||
		typeof params.evidence !== "string"
	) {
		throw new AutonomyTransitionError("Invalid autonomy gate evidence");
	}
	return {
		gateId: params.gateId,
		status: params.status,
		evidence: params.evidence,
	};
}

export class AutonomyRuntime {
	private controller: AutonomyController | null = null;
	private cwd: string | null = null;

	constructor(private readonly pi: ExtensionAPI) {}

	async attach(ctx: Pick<ExtensionContext, "cwd">): Promise<void> {
		if (this.cwd === ctx.cwd && this.controller !== null) return;
		this.cwd = ctx.cwd;
		this.controller = new AutonomyController(new AutonomyStore(ctx.cwd));
	}

	async start(task: string, maxAttempts: number): Promise<AutonomyRun> {
		return (await this.requireController()).start({
			task,
			maxAttempts,
			gates: [
				{ id: "native-goal", label: "OMP native goal" },
				{ id: "verification", label: "Targeted verification" },
			],
		});
	}

	async get(): Promise<AutonomyRun | null> {
		return (await this.requireController()).get();
	}

	async pause(): Promise<AutonomyRun> {
		return (await this.requireController()).pause();
	}

	async resume(): Promise<AutonomyRun> {
		return (await this.requireController()).resume();
	}

	async cancel(): Promise<AutonomyRun> {
		return (await this.requireController()).cancel();
	}

	async recordGate(args: {
		gateId: string;
		status: "pass" | "fail";
		evidence: string;
	}): Promise<AutonomyRun> {
		const controller = await this.requireController();
		const state = await controller.get();
		if (state === null) {
			throw new AutonomyTransitionError("No autonomy run exists");
		}
		return controller.recordGate({
			...args,
			attempt: state.attempt,
			artifactRevision: state.artifactRevision,
		});
	}

	async onGoalUpdated(event: NativeGoalUpdatedEvent): Promise<void> {
		if (event.goal?.status !== "complete") return;
		const controller = await this.requireController();
		const state = await controller.get();
		if (
			state === null ||
			ACTIVE_STATUSES[state.status] !== true ||
			!state.gates.some((gate) => gate.id === "native-goal")
		) {
			return;
		}
		await controller.recordGate({
			gateId: "native-goal",
			status: "pass",
			evidence: `goal:${event.goal.id}:complete`,
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
			return;
		}
		const continuation = await controller.continueAfterIncomplete();
		if (continuation.failed) {
			this.pi.logger.warn("Autonomy run failed at its maximum attempt bound");
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

	private async requireController(): Promise<AutonomyController> {
		if (this.controller === null) {
			throw new AutonomyTransitionError(
				"Autonomy runtime is not attached to a project",
			);
		}
		return this.controller;
	}
}

export function registerAutonomy(pi: ExtensionAPI): AutonomyRuntime {
	const runtime = new AutonomyRuntime(pi);
	pi.on("session_start", (_event, ctx) => runtime.attach(ctx));
	pi.on("session_switch", (_event, ctx) => runtime.attach(ctx));
	pi.on("session_branch", (_event, ctx) => runtime.attach(ctx));
	pi.on("goal_updated", (event) => runtime.onGoalUpdated(event));
	pi.on("agent_end", (event) => runtime.onAgentEnd(event));
	registerAutonomyCommands(pi, runtime);

	const z = pi.zod;
	pi.registerTool({
		name: "autonomy_gate",
		label: "Autonomy Gate",
		description:
			"Record concrete pass/fail evidence for a configured Pantheon autonomy completion gate",
		parameters: z.object({
			gateId: z.string().describe("Configured gate identifier"),
			status: z.enum(["pass", "fail"]).describe("Observed gate outcome"),
			evidence: z
				.string()
				.describe("Concrete command, report, or artifact evidence"),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await runtime.attach(ctx);
			const gateEvidence = parseGateEvidence(params);
			const state = await runtime.recordGate(gateEvidence);
			return {
				content: [
					{
						type: "text",
						text: `Autonomy gate ${gateEvidence.gateId}=${gateEvidence.status} recorded for attempt ${state.attempt}, artifact ${state.artifactRevision}.`,
					},
				],
				details: {
					runId: state.id,
					gateId: gateEvidence.gateId,
					status: gateEvidence.status,
					attempt: state.attempt,
					artifactRevision: state.artifactRevision,
				},
			};
		},
	});
	return runtime;
}
