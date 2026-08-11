/**
 * Comment checker hook (OMP port of OMO's comment-checker).
 *
 * After a successful `edit`/`write`, scans the newly written text for
 * AI-slop comment patterns (comments that restate the code, decorative
 * separators, context-free TODOs, single-word noise, …) and appends a
 * non-blocking warning to the tool result so the agent sees it inline and
 * can clean up. Never blocks the edit.
 *
 * Grounded on the documented `tool_result` surface: handlers receive
 * `{ toolName, input, content, details, isError }` and may return
 * `{ content }` to patch what the agent sees.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const HOOK_NAME = "comment-checker";

/** Tools whose written output we inspect for newly added comments. */
const CHECKED_TOOLS: Record<string, true> = { edit: true, write: true };

/** Per-file cooldown so a burst of edits to one file warns at most once. */
const DEDUP_WINDOW_MS = 30_000;

// ── Comment detection heuristics ────────────────────────────────────────

const COMMENT_SYNTAX_RE = /^\s*(\/\/|\/\*|\*|#(?!!)|--|<!--)/;
const BLOCK_COMMENT_RE = /<!--[\s\S]*-->/;

function hasCommentSyntax(text: string | undefined): boolean {
	if (!text) return false;
	return COMMENT_SYNTAX_RE.test(text) || BLOCK_COMMENT_RE.test(text);
}

type SlopMatcher = (body: string) => string | null;

const SLOP_MATCHERS: SlopMatcher[] = [
	(body) =>
		/^this\s+(function|method|class|variable|constant|module|hook|handler|component|helper)\s+(does|returns|is|creates|handles|processes|manages|initializes|sets up)/i.test(
			body,
		)
			? "Restates what the name already says"
			: null,
	(body) =>
		/^(initialize|set|create|get|update|delete|remove|add|handle|process|fetch|render|display|check|validate|verify|ensure|configure|setup|build|generate|compute|calculate)\s+the\s+/i.test(
			body,
		)
			? "Restates the code below it"
			: null,
	(body) =>
		/^(TODO|FIXME|HACK|XXX|TEMP)\s*[:.]?\s*$/i.test(body)
			? "TODO/FIXME without context — add what and why"
			: null,
	(body) =>
		/^(import|export)\s+(the\s+)?/i.test(body)
			? "Restates an import/export statement"
			: null,
	(body) =>
		/^define\s+(the\s+)?(interface|type|enum|constant|variable)/i.test(body)
			? "Restates a type definition"
			: null,
	(body) =>
		/^returns?\s+(the\s+)?(result|value|data|response|output|object|array|string|number|boolean)\b/i.test(
			body,
		)
			? "Restates a return statement"
			: null,
	(body) => (/^\w+$/.test(body) ? "Single-word comment — too vague" : null),
	(body) =>
		/^[-=~*#]{3,}\s*\w*\s*[-=~*#]*$/.test(body)
			? "Decorative separator — use code structure instead"
			: null,
	(body) =>
		/^(end\s+of|close|closing)\s+/i.test(body)
			? "End-of-block comment — brace/indent already shows this"
			: null,
];

function stripCommentPrefix(line: string): string {
	return line
		.replace(/^\s*(?:\/\/|\/\*+|\*\/|\*|#(?!!)|--|<!--)\s*/, "")
		.replace(/\s*(?:\*\/|-->)\s*$/, "")
		.trim();
}

function detectSlopComments(
	text: string,
): Array<{ line: string; reason: string }> {
	const findings: Array<{ line: string; reason: string }> = [];
	for (const rawLine of text.split("\n")) {
		const trimmed = rawLine
			.replace(/^[+\s]+/, (m) => m.replace(/\+/g, ""))
			.trim();
		if (!hasCommentSyntax(trimmed)) continue;
		const body = stripCommentPrefix(trimmed);
		if (!body) continue;
		for (const matcher of SLOP_MATCHERS) {
			const reason = matcher(body);
			if (reason) {
				findings.push({ line: trimmed, reason });
				break;
			}
		}
	}
	return findings;
}

/** Recursively collect every string value (incl. nested `edits[].new_text`, patch bodies). */
function collectStrings(value: unknown, out: string[]): void {
	if (typeof value === "string") {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const v of value) collectStrings(v, out);
	} else if (value && typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>))
			collectStrings(v, out);
	}
}

function extractWrittenText(input: unknown): string {
	const out: string[] = [];
	collectStrings(input, out);
	return out.join("\n");
}

// Path is explicit for write/replace/patch; embedded in the body for hashline/apply_patch.
const HASHLINE_HEADER_RE = /\[([^\]\s#]+)#[A-Fa-f0-9]{4}\]/; // [path#TAG]
const PATCH_FILE_RE = /\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)/;

function filePathOf(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const rec = input as Record<string, unknown>;
	const direct = rec.path ?? rec.filePath ?? rec.file_path;
	if (typeof direct === "string") return direct;
	const blob = extractWrittenText(input);
	const h = HASHLINE_HEADER_RE.exec(blob);
	if (h) return h[1];
	const p = PATCH_FILE_RE.exec(blob);
	if (p?.[1]) return p[1].trim();
	return undefined;
}

// ── Registration ────────────────────────────────────────────────────────

/**
 * Prose/data/markup files where `#`, `*`, `--`, `<!--` are NOT code comments
 * (markdown headings/bullets, etc.) — scanning them produces false positives.
 */
const SKIP_EXTENSIONS: Record<string, true> = {
	md: true,
	mdx: true,
	markdown: true,
	txt: true,
	rst: true,
	adoc: true,
	json: true,
	jsonc: true,
	csv: true,
	tsv: true,
	lock: true,
	svg: true,
	html: true,
	htm: true,
	xml: true,
	yaml: true,
	yml: true,
	toml: true,
};

function isNonCodeFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase();
	return ext ? SKIP_EXTENSIONS[ext] === true : false;
}

export function registerCommentChecker(pi: ExtensionAPI): void {
	// Dynamic per-file dedup → Map (runtime keys, not a static table).
	const lastWarnedByFile = new Map<string, number>();

	pi.on("tool_result", (event) => {
		if (!CHECKED_TOOLS[event.toolName] || event.isError) return;

		const filePath = filePathOf(event.input);
		// Only skip when we KNOW the file is prose/data. Unknown path → still scan
		// (hashline/apply_patch may hide the path); per-line detection is cheap.
		if (filePath && isNonCodeFile(filePath)) return;
		const dedupKey = filePath ?? "(unknown)";
		const now = Date.now();
		const last = lastWarnedByFile.get(dedupKey) ?? 0;
		if (now - last < DEDUP_WINDOW_MS) return;

		// detectSlopComments filters per-line; no broken whole-blob pre-gate here.
		const findings = detectSlopComments(extractWrittenText(event.input));
		if (findings.length === 0) return;

		lastWarnedByFile.set(dedupKey, now);

		const warning = [
			'<system-reminder type="comment-checker">',
			`Detected ${findings.length} potentially redundant/obvious comment${findings.length > 1 ? "s" : ""} in \`${filePath ?? "the edited file"}\`:`,
			...findings.slice(0, 8).map((f) => `  • ${f.reason}: ${f.line}`),
			"Remove comments that merely restate the code. Good comments explain *why*, not *what*.",
			"</system-reminder>",
		].join("\n");

		pi.logger.debug(
			`[${HOOK_NAME}] ${findings.length} slop comment(s) in ${dedupKey}`,
		);

		// Append (don't replace) the warning to what the agent sees.
		return {
			content: [
				...event.content,
				{ type: "text" as const, text: `\n${warning}` },
			],
		};
	});
}
