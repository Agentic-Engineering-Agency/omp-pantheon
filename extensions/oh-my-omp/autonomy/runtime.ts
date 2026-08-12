import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";

import { canonicalProjectRoot } from "../private-state";
import {
	type AgentdStatus,
	AutonomyAgentd,
	currentAgentdCommandId,
	isCurrentAgentdRun,
	reconcileResidentTerminal,
} from "./agentd";
import { registerAutonomyCommands } from "./commands";
import { AutonomyController, AutonomyTransitionError } from "./controller";
import { configuredAutonomyGates, evaluateConfiguredHostGates } from "./gates";
import { CommandJournal } from "./journal";
import {
	prepareAutonomyProjectStateRoot,
	prepareAutonomyRuntimeRoot,
} from "./runtime-paths";
import { PersistedScheduler } from "./scheduler";
import { AutonomyStore } from "./store";
import type { AutonomyRun, AutonomyTerminalStatus } from "./types";

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

const TERMINAL_WORKER_STATES = new Set(["exited", "failed", "stopped"]);

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

interface AgentdClient {
	start(runId: string): Promise<AgentdStatus>;
	status(runId: string): Promise<AgentdStatus>;
	stop(runId: string): Promise<AgentdStatus>;
	close(): void;
}

export interface AutonomyRuntimeOptions {
	stateHome?: string | ((cwd: string) => string);
	agentdFactory?: (cwd: string, stateHome?: string) => AgentdClient;
	now?: () => string;
	isResidentWorker?: (runId: string) => boolean;
	residentCommandId?: (runId: string) => string | undefined;
	prepareProjectStateRoot?: typeof prepareAutonomyProjectStateRoot;
}

export class AutonomyRuntime {
	private controller: AutonomyController | null = null;
	private store: AutonomyStore | null = null;
	private agentd: AgentdClient | null = null;
	private cwd: string | null = null;
	private stateHome: string | undefined;
	private attachmentGeneration = 0;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly verifier: VerificationRunner = defaultVerificationRunner,
		private readonly options: AutonomyRuntimeOptions = {},
	) {}

	async attach(
		ctx: Pick<ExtensionContext, "cwd"> &
			Partial<Pick<ExtensionContext, "sessionManager">>,
	): Promise<void> {
		const resolvedCwd = canonicalProjectRoot(ctx.cwd);
		if (
			this.cwd === resolvedCwd &&
			this.controller !== null &&
			(this.agentd !== null || ctx.sessionManager === undefined)
		) {
			return;
		}

		const generation = ++this.attachmentGeneration;
		const stateHome =
			typeof this.options.stateHome === "function"
				? this.options.stateHome(resolvedCwd)
				: this.options.stateHome;
		const prepareProjectStateRoot =
			this.options.prepareProjectStateRoot ?? prepareAutonomyProjectStateRoot;
		const stateDirectory =
			ctx.sessionManager === undefined && stateHome === undefined
				? undefined
				: await prepareProjectStateRoot(resolvedCwd, stateHome);
		const store = new AutonomyStore(resolvedCwd, { stateDirectory });
		const controller = new AutonomyController(store);
		const agentd =
			ctx.sessionManager === undefined
				? null
				: (this.options.agentdFactory?.(resolvedCwd, stateHome) ??
					new AutonomyAgentd(resolvedCwd, { stateHome }));
		const state = await controller.get();
		if (state !== null && ACTIVE_STATUSES[state.status] === true) {
			await agentd?.start(state.id);
		}
		if (generation !== this.attachmentGeneration) {
			agentd?.close();
			return;
		}

		const previousAgentd = this.agentd;
		this.cwd = resolvedCwd;
		this.stateHome = stateHome;
		this.store = store;
		this.controller = controller;
		this.agentd = agentd;
		previousAgentd?.close();
	}

	async start(
		task: string,
		maxAttempts: number,
		verificationCommand: string,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<AutonomyRun> {
		this.requireRunProject(ctx);
		const sessionFile = ctx.sessionManager?.getSessionFile();
		if (sessionFile === undefined) {
			throw new AutonomyTransitionError(
				"Autonomy requires a persisted OMP session; --no-session is unsupported",
			);
		}
		const state = await (await this.requireController()).start({
			task,
			maxAttempts,
			verificationCommand,
			gates: configuredAutonomyGates(
				this.cwd ?? "",
				this.stateHome,
				this.options.now?.() ?? new Date().toISOString(),
			),
			ownerSessionFile: resolve(sessionFile),
		});
		await this.agentd?.start(state.id);
		return state;
	}

	async get(ctx: Pick<ExtensionContext, "cwd">): Promise<AutonomyRun | null> {
		this.requireRunProject(ctx);
		return (await this.requireController()).get();
	}
	async getWorkerStatus(
		ctx: Pick<ExtensionContext, "cwd">,
	): Promise<AgentdStatus | null> {
		this.requireRunProject(ctx);
		if (!this.agentd) return null;
		const state = await (await this.requireController()).get();
		if (state === null) return null;
		try {
			return await this.agentd.status(state.id);
		} catch {
			return { state: "stopped", restartCount: 0 };
		}
	}

	async pause(ctx: Pick<ExtensionContext, "cwd">): Promise<AutonomyRun> {
		this.requireRunProject(ctx);
		const controller = await this.requireController();
		const state = await controller.get();
		if (state === null) {
			throw new AutonomyTransitionError("No autonomy run exists");
		}
		if (state.status === "paused") return controller.pause(state.id);
		if (ACTIVE_STATUSES[state.status] !== true) {
			return controller.pause(state.id);
		}
		if (await this.requestResidentTerminal(controller, state.id, "paused")) {
			return (await controller.get()) ?? state;
		}
		await this.stopAgentdAndRequireTerminal(state.id);
		const stoppedState = await this.requireRun(controller, state.id, "pause");
		const reconciled =
			await this.reconcilePendingTerminalAfterStop(stoppedState);
		if (reconciled !== null) {
			if (reconciled.status === "paused") return reconciled;
			throw new AutonomyTransitionError(
				`Pending terminal transition resolved as ${reconciled.status}; pause was not applied`,
			);
		}
		return controller.pause(state.id);
	}

	async resume(ctx: Pick<ExtensionContext, "cwd">): Promise<AutonomyRun> {
		this.requireRunProject(ctx);
		const state = await (await this.requireController()).resume();
		await this.agentd?.start(state.id);
		await this.scheduleContinuation(
			state,
			state.gates
				.filter((gate) => gate.status !== "pass")
				.map((gate) => gate.id),
		);
		return state;
	}

	async cancel(ctx: Pick<ExtensionContext, "cwd">): Promise<AutonomyRun> {
		this.requireRunProject(ctx);
		const controller = await this.requireController();
		const state = await controller.get();
		if (state === null) {
			throw new AutonomyTransitionError("No autonomy run exists");
		}
		if (await this.requestResidentTerminal(controller, state.id, "cancelled")) {
			return (await controller.get()) ?? state;
		}
		await this.stopAgentdAndRequireTerminal(state.id);
		const stoppedState = await this.requireRun(controller, state.id, "cancel");
		const reconciled =
			await this.reconcilePendingTerminalAfterStop(stoppedState);
		if (reconciled !== null) {
			if (reconciled.status === "cancelled") return reconciled;
			throw new AutonomyTransitionError(
				`Pending terminal transition resolved as ${reconciled.status}; cancellation was not applied`,
			);
		}
		return controller.cancel(state.id);
	}

	async runVerification(
		signal: AbortSignal | undefined,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<AutonomyRun> {
		this.requireRunProject(ctx);
		const controller = await this.requireController();
		const state = await controller.get();
		if (state === null) {
			throw new AutonomyTransitionError("No autonomy run exists");
		}
		if (ACTIVE_STATUSES[state.status] !== true) {
			throw new AutonomyTransitionError(
				`Cannot verify autonomy while ${state.status}`,
			);
		}
		if (state.terminalIntent !== undefined) {
			throw new AutonomyTransitionError(
				`Cannot verify autonomy while terminal transition for command ${state.terminalIntent.commandId} is pending`,
			);
		}
		if (!this.ownsRunSession(state, ctx)) {
			throw new AutonomyTransitionError(
				"Cannot verify autonomy from a session that does not own the run",
			);
		}
		const receipt = await this.verifier.verify(
			this.cwd ?? "",
			state.verificationCommand,
			signal,
		);
		return controller.recordGate(
			{
				gateId: "verification",
				status: receipt.status,
				evidence: receipt.evidence,
				reporter: "host-verifier",
				attempt: state.attempt,
				artifactRevision: state.artifactRevision,
			},
			state.id,
		);
	}

	async onGoalUpdated(
		event: NativeGoalUpdatedEvent,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<void> {
		if (!this.ownsRunProject(ctx)) return;
		if (event.goal === null) return;
		const controller = await this.requireController();
		const state = await controller.get();
		if (
			state === null ||
			ACTIVE_STATUSES[state.status] !== true ||
			state.terminalIntent !== undefined ||
			!state.gates.some((gate) => gate.id === "native-goal")
		) {
			return;
		}
		if (!this.ownsRunSession(state, ctx)) return;
		if (state.nativeGoalId === undefined) {
			if (
				event.goal.status === "active" &&
				event.goal.objective.trim() === state.task
			) {
				await controller.bindNativeGoal(
					{
						id: event.goal.id,
						objective: event.goal.objective,
					},
					state.id,
				);
			}
			return;
		}
		if (
			event.goal.id !== state.nativeGoalId ||
			event.goal.status !== "complete"
		) {
			return;
		}
		await controller.recordGate(
			{
				gateId: "native-goal",
				status: "pass",
				evidence: `goal:${event.goal.id}:complete`,
				reporter: "native-goal-event",
				attempt: state.attempt,
				artifactRevision: state.artifactRevision,
			},
			state.id,
		);
	}

	async onToolResult(
		event: ToolResultEvent,
		ctx: Pick<ExtensionContext, "cwd">,
	): Promise<void> {
		if (!this.ownsRunProject(ctx)) return;
		if (
			["read", "grep", "glob", "goal", "autonomy_gate"].includes(event.toolName)
		) {
			return;
		}
		const controller = await this.requireController();
		const state = await controller.get();
		if (
			state === null ||
			(ACTIVE_STATUSES[state.status] !== true && state.status !== "paused")
		) {
			return;
		}
		if (state.terminalIntent !== undefined) {
			await controller.failTerminalIntent(
				state.terminalIntent.commandId,
				`Artifact mutation ${event.toolName} occurred while terminal persistence was pending`,
				state.id,
			);
			return;
		}
		const evidence = createHash("sha256")
			.update(
				JSON.stringify({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: event.input,
					isError: event.isError,
				}),
			)
			.digest("hex");
		await controller.recordArtifactRevision(
			`tool:${event.toolName}:${evidence}`,
			state.id,
		);
	}

	async onAgentEnd(
		_event: AgentEndEvent,
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<void> {
		if (!this.ownsRunProject(ctx)) return;
		const controller = await this.requireController();
		const state = await controller.get();
		if (state === null || ACTIVE_STATUSES[state.status] !== true) return;
		if (!this.ownsRunSession(state, ctx)) return;
		if (state.terminalIntent !== undefined) {
			this.pi.logger.debug(
				`Autonomy terminal transition for command ${state.terminalIntent.commandId} remains pending`,
			);
			return;
		}

		for (const receipt of evaluateConfiguredHostGates(
			this.cwd ?? "",
			state,
			this.stateHome,
		)) {
			await controller.recordGate(
				{
					...receipt,
					attempt: state.attempt,
					artifactRevision: state.artifactRevision,
				},
				state.id,
			);
		}
		const decision = await controller.assessCompletion(state.id);
		if (decision.completed) {
			if (
				await this.requestResidentTerminal(controller, state.id, "succeeded")
			) {
				this.pi.logger.debug(
					"Autonomy success is pending resident command acknowledgement",
				);
				return;
			}
			await this.stopAgentdAndRequireTerminal(state.id);
			const stoppedState = await this.requireRun(
				controller,
				state.id,
				"mark completion",
			);
			const reconciled =
				await this.reconcilePendingTerminalAfterStop(stoppedState);
			if (reconciled !== null) {
				if (reconciled.status === "succeeded") {
					this.pi.logger.info(
						"Autonomy run succeeded after objective gates passed",
					);
					return;
				}
				throw new AutonomyTransitionError(
					`Pending terminal transition resolved as ${reconciled.status}; completion was not applied`,
				);
			}
			await controller.markSucceeded(state.id);
			this.pi.logger.info(
				"Autonomy run succeeded after objective gates passed",
			);
			return;
		}
		const continuation = await controller.assessContinuation(state.id);
		if (continuation.failed) {
			if (await this.requestResidentTerminal(controller, state.id, "failed")) {
				this.pi.logger.debug(
					"Autonomy failure is pending resident command acknowledgement",
				);
				return;
			}
			await this.stopAgentdAndRequireTerminal(state.id);
			const stoppedState = await this.requireRun(
				controller,
				state.id,
				"mark attempt-bound failure",
			);
			const reconciled =
				await this.reconcilePendingTerminalAfterStop(stoppedState);
			if (reconciled !== null) {
				if (reconciled.status === "failed") {
					this.pi.logger.warn(
						"Autonomy run failed at its maximum attempt bound",
					);
					return;
				}
				throw new AutonomyTransitionError(
					`Pending terminal transition resolved as ${reconciled.status}; attempt-bound failure was not applied`,
				);
			}
			await controller.markFailedAtAttemptBound(state.id);
			this.pi.logger.warn("Autonomy run failed at its maximum attempt bound");
			return;
		}
		const nextContinuation = await controller.continueAfterIncomplete(state.id);
		const next = await this.requireRun(
			controller,
			state.id,
			"schedule a continuation",
		);
		await this.scheduleContinuation(next, nextContinuation.pendingGateIds);
	}

	async close(): Promise<void> {
		const state = await this.controller?.get();
		if (
			state !== null &&
			state !== undefined &&
			ACTIVE_STATUSES[state.status] !== true &&
			!this.isResidentWorker(state.id)
		) {
			await this.stopAgentd(state.id);
		}
		this.agentd?.close();
		this.agentd = null;
	}

	private async scheduleContinuation(
		state: AutonomyRun,
		pendingGateIds: string[],
	): Promise<void> {
		if (this.cwd === null) {
			throw new AutonomyTransitionError(
				"Cannot schedule autonomy without an attached project",
			);
		}
		const root = await prepareAutonomyRuntimeRoot(
			this.cwd,
			state.id,
			this.stateHome,
		);
		const journal = new CommandJournal(root, {
			expectedRunId: state.id,
			expectedCwd: this.cwd,
		});
		const scheduler = new PersistedScheduler(root, journal);
		const suffix = `attempt-${state.attempt}-artifact-${state.artifactRevision}`;
		const now = this.options.now?.() ?? new Date().toISOString();
		await scheduler.schedule({
			schemaVersion: 1,
			id: `continuation-${suffix}`,
			coalesceKey: `${state.id}:${suffix}`,
			deadline: now,
			command: {
				schemaVersion: 1,
				id: `command-${suffix}`,
				runId: state.id,
				cwd: this.cwd,
				sessionFile: state.ownerSessionFile,
				prompt: this.continuationPrompt(pendingGateIds),
				maxAttempts: 3,
				createdAt: now,
			},
		});
	}

	private ownsRunProject(ctx: Pick<ExtensionContext, "cwd">): boolean {
		return this.cwd !== null && canonicalProjectRoot(ctx.cwd) === this.cwd;
	}

	private requireRunProject(ctx: Pick<ExtensionContext, "cwd">): void {
		if (!this.ownsRunProject(ctx)) {
			throw new AutonomyTransitionError(
				"Autonomy runtime context changed while the operation was pending",
			);
		}
	}

	private ownsRunSession(
		state: AutonomyRun,
		ctx: Pick<ExtensionContext, "sessionManager">,
	): boolean {
		const sessionFile = ctx.sessionManager?.getSessionFile();
		return (
			sessionFile !== undefined &&
			state.ownerSessionFile === resolve(sessionFile)
		);
	}

	private continuationPrompt(pendingGateIds: string[]): string {
		return [
			"<system-reminder>",
			`Verified autonomy continues. Missing gates: ${pendingGateIds.join(", ")}.`,
			"Produce current objective evidence; completion promises and prose do not satisfy gates.",
			"</system-reminder>",
		].join("\n");
	}

	private isResidentWorker(runId: string): boolean {
		return this.options.isResidentWorker?.(runId) ?? isCurrentAgentdRun(runId);
	}

	private residentCommandId(runId: string): string | undefined {
		return (
			this.options.residentCommandId?.(runId) ?? currentAgentdCommandId(runId)
		);
	}

	private async requestResidentTerminal(
		controller: AutonomyController,
		runId: string,
		status: AutonomyTerminalStatus,
	): Promise<boolean> {
		if (!this.isResidentWorker(runId)) return false;
		const commandId = this.residentCommandId(runId);
		if (commandId === undefined) {
			throw new AutonomyTransitionError(
				"Resident autonomy transition has no active command",
			);
		}
		await controller.requestTerminalIntent(status, commandId, runId);
		return true;
	}

	private async reconcilePendingTerminalAfterStop(
		state: AutonomyRun,
	): Promise<AutonomyRun | null> {
		if (state.terminalIntent === undefined) return null;
		if (this.cwd === null || this.store === null) {
			throw new AutonomyTransitionError(
				"Cannot reconcile terminal intent without attached private state",
			);
		}
		const root = await prepareAutonomyRuntimeRoot(
			this.cwd,
			state.id,
			this.stateHome,
		);
		const journal = new CommandJournal(root, {
			expectedRunId: state.id,
			expectedCwd: this.cwd,
		});
		await reconcileResidentTerminal(state.id, this.store, journal);
		const reconciled = await this.requireRun(
			await this.requireController(),
			state.id,
			"reconcile a terminal transition",
		);
		if (reconciled.terminalIntent !== undefined) {
			throw new AutonomyTransitionError(
				`Terminal transition for command ${reconciled.terminalIntent.commandId} remains unresolved`,
			);
		}
		return ACTIVE_STATUSES[reconciled.status] === true ? null : reconciled;
	}

	private async requireRun(
		controller: AutonomyController,
		expectedRunId: string,
		action: string,
	): Promise<AutonomyRun> {
		const state = await controller.get();
		if (state === null) {
			throw new AutonomyTransitionError(
				`Autonomy run disappeared while attempting to ${action}`,
			);
		}
		if (state.id !== expectedRunId) {
			throw new AutonomyTransitionError(
				`Autonomy run changed from ${expectedRunId} to ${state.id} while attempting to ${action}`,
			);
		}
		return state;
	}

	private async stopAgentdAndRequireTerminal(runId: string): Promise<void> {
		if (this.agentd === null) return;
		const worker = await this.agentd.stop(runId);
		if (!TERMINAL_WORKER_STATES.has(worker.state)) {
			throw new AutonomyTransitionError(
				`Autonomy worker stop is not terminal: ${worker.state}`,
			);
		}
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
	options: AutonomyRuntimeOptions = {},
): AutonomyRuntime {
	const runtime = new AutonomyRuntime(pi, verifier, options);
	pi.on("session_start", (_event, ctx) => runtime.attach(ctx));
	pi.on("session_switch", (_event, ctx) => runtime.attach(ctx));
	pi.on("session_branch", (_event, ctx) => runtime.attach(ctx));
	pi.on("goal_updated", (event, ctx) => runtime.onGoalUpdated(event, ctx));
	pi.on("agent_end", (event, ctx) => runtime.onAgentEnd(event, ctx));
	pi.on("tool_result", (event, ctx) => runtime.onToolResult(event, ctx));
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
			const state = await runtime.runVerification(signal, ctx);
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
