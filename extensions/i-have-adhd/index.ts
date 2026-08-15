import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(
	EXTENSION_DIR,
	"..",
	"..",
	"skills",
	"i-have-adhd",
	"SKILL.md",
);
const STATE_ENTRY_TYPE = "i-have-adhd-state";
const RULES_MESSAGE_TYPE = "i-have-adhd-rules";
const DISABLED_MESSAGE_TYPE = "i-have-adhd-disabled";
const STATUS_KEY = "i-have-adhd";
const STOP_PHRASES: Record<string, true> = {
	"stop adhd mode": true,
	"normal mode": true,
};
const RULES_HEADER =
	'ADHD MODE ACTIVE. The ruleset below applies to every response until turned off. "stop adhd mode" or "normal mode" turns it off for this session.';
const DISABLED_NOTICE =
	"ADHD MODE OFF. Ignore the i-have-adhd ruleset injected earlier in this conversation and return to your default response style.";

type AdhdModeState = {
	enabled: boolean;
};

function stripFrontmatter(content: string): string {
	return content
		.replace(/^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, "")
		.trim();
}

function loadRules(): string {
	const rules = stripFrontmatter(readFileSync(SKILL_PATH, "utf8"));
	if (!rules)
		throw new Error(`The i-have-adhd rules file is empty: ${SKILL_PATH}`);
	return rules;
}

function getSavedState(ctx: ExtensionContext): boolean | undefined {
	let savedState: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE)
			continue;
		const data = entry.data as Partial<AdhdModeState> | undefined;
		if (typeof data?.enabled === "boolean") savedState = data.enabled;
	}
	return savedState;
}

function rulesAreInContext(ctx: ExtensionContext): boolean {
	let active = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			active = false;
			continue;
		}
		if (entry.type !== "custom_message") continue;
		if (entry.customType === RULES_MESSAGE_TYPE) active = true;
		if (entry.customType === DISABLED_MESSAGE_TYPE) active = false;
	}
	return active;
}

export default function registerIHaveAdhd(pi: ExtensionAPI): void {
	const rules = loadRules();
	const alwaysOnFlag = join(
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"),
		".i-have-adhd-always",
	);
	let enabled = false;

	const updateStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(STATUS_KEY, enabled ? "● ADHD ON" : undefined);
	};

	const syncContext = (ctx: ExtensionContext): void => {
		const injected = rulesAreInContext(ctx);
		if (enabled && !injected) {
			pi.sendMessage(
				{
					customType: RULES_MESSAGE_TYPE,
					content: `${RULES_HEADER}\n\n${rules}`,
					display: false,
				},
				{ triggerTurn: false },
			);
		}
		if (!enabled && injected) {
			pi.sendMessage(
				{
					customType: DISABLED_MESSAGE_TYPE,
					content: DISABLED_NOTICE,
					display: false,
				},
				{ triggerTurn: false },
			);
		}
	};

	const restoreState = (ctx: ExtensionContext): void => {
		const savedState = getSavedState(ctx);
		const enabledByDefault =
			pi.getFlag("adhd") === true || existsSync(alwaysOnFlag);
		enabled = savedState ?? enabledByDefault;
		if (savedState === undefined && enabled) {
			pi.appendEntry(STATE_ENTRY_TYPE, { enabled } satisfies AdhdModeState);
		}
		updateStatus(ctx);
		syncContext(ctx);
	};

	const setEnabled = (nextEnabled: boolean, ctx: ExtensionContext): void => {
		enabled = nextEnabled;
		pi.appendEntry(STATE_ENTRY_TYPE, { enabled } satisfies AdhdModeState);
		updateStatus(ctx);
		syncContext(ctx);
		ctx.ui.notify(`ADHD mode ${enabled ? "enabled" : "disabled"}`, "info");
	};

	pi.registerFlag("adhd", {
		description: "Start with ADHD-friendly output enabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("i-have-adhd", {
		description: "Toggle ADHD-friendly output for this session",
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument === "") return setEnabled(!enabled, ctx);
			if (argument === "on") return setEnabled(true, ctx);
			if (argument === "off" || argument === "stop")
				return setEnabled(false, ctx);
			ctx.ui.notify("Usage: /i-have-adhd [on|off]", "warning");
		},
	});

	pi.on("input", async (event, ctx) => {
		const input = event.text.trim().toLowerCase();
		if (input === "/skill:i-have-adhd") {
			setEnabled(true, ctx);
			return { handled: true };
		}
		if (enabled && STOP_PHRASES[input]) {
			setEnabled(false, ctx);
			return ctx.hasUI
				? { handled: true }
				: { text: "Reply with exactly: ADHD mode disabled.", images: [] };
		}
		return {};
	});

	pi.on("session_start", async (_event, ctx) => restoreState(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreState(ctx));
	pi.on("session_branch", async (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
	pi.on("session_compact", async (_event, ctx) => syncContext(ctx));
}
