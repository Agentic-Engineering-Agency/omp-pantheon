import { Type } from "typebox";

export const EVAL_CONFIG_SCHEMA_VERSION = "evalfly.config.v1" as const;
export const EVAL_CASE_SCHEMA_VERSION = "evalfly.case.v1" as const;
export const EVAL_RUN_SCHEMA_VERSION = "evalfly.run.v1" as const;

export const EVAL_SUITES = ["smoke", "regression", "benchmark"] as const;
export const EVAL_RISK_TIERS = ["critical", "major", "minor"] as const;
export const EVAL_JUDGE_TYPES = ["deterministic", "llm", "human"] as const;

const nonEmptyString = Type.String({ minLength: 1 });

const EvalSuiteSchema = Type.Union([
	Type.Literal("smoke"),
	Type.Literal("regression"),
	Type.Literal("benchmark"),
]);

const EvalRiskTierSchema = Type.Union([
	Type.Literal("critical"),
	Type.Literal("major"),
	Type.Literal("minor"),
]);

const FileExistsAssertionSchema = Type.Object(
	{
		type: Type.Literal("file_exists"),
		path: nonEmptyString,
	},
	{ additionalProperties: false },
);

const EvalSourceSchema = Type.Object(
	{
		kind: nonEmptyString,
	},
	{ additionalProperties: true },
);

const EvalPrivacySchema = Type.Object(
	{
		classification: nonEmptyString,
		sanitized: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const EvalExpectedSchema = Type.Object(
	{
		success_criteria: Type.Array(nonEmptyString, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const DeterministicJudgeSchema = Type.Object(
	{
		type: Type.Literal("deterministic"),
		assertions: Type.Array(FileExistsAssertionSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const LlmJudgeSchema = Type.Object(
	{
		type: Type.Literal("llm"),
		rubric: nonEmptyString,
		model: Type.Optional(nonEmptyString),
	},
	{ additionalProperties: false },
);

const HumanJudgeSchema = Type.Object(
	{
		type: Type.Literal("human"),
		rubric: nonEmptyString,
		reviewer: Type.Optional(nonEmptyString),
	},
	{ additionalProperties: false },
);

export const EvalCaseSchema = Type.Object(
	{
		schema_version: Type.Literal(EVAL_CASE_SCHEMA_VERSION),
		case_id: nonEmptyString,
		title: nonEmptyString,
		suite: EvalSuiteSchema,
		risk_tier: EvalRiskTierSchema,
		task_type: nonEmptyString,
		source: EvalSourceSchema,
		privacy: EvalPrivacySchema,
		expected: EvalExpectedSchema,
		judge: Type.Union([
			DeterministicJudgeSchema,
			LlmJudgeSchema,
			HumanJudgeSchema,
		]),
	},
	{ additionalProperties: false },
);

export const EvalConfigSchema = Type.Object(
	{
		schema_version: Type.Literal(EVAL_CONFIG_SCHEMA_VERSION),
		name: nonEmptyString,
		cases: Type.Array(EvalCaseSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const EvalRunContextSchema = Type.Object(
	{
		spec_slice: Type.Optional(nonEmptyString),
		session_id: Type.Optional(nonEmptyString),
		commit_range: Type.Optional(nonEmptyString),
		eval_report_path: nonEmptyString,
	},
	{ additionalProperties: false },
);

const EvalRunSummarySchema = Type.Object(
	{
		total: Type.Integer({ minimum: 0 }),
		passed: Type.Integer({ minimum: 0 }),
		failed: Type.Integer({ minimum: 0 }),
		critical_regressions: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const EvalRunResultSchema = Type.Object(
	{
		case_id: nonEmptyString,
		title: nonEmptyString,
		risk_tier: EvalRiskTierSchema,
		critical: Type.Boolean(),
		passed: Type.Boolean(),
		privacy: EvalPrivacySchema,
		errors: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export const EvalRunSchema = Type.Object(
	{
		schema_version: Type.Literal(EVAL_RUN_SCHEMA_VERSION),
		run_id: nonEmptyString,
		suite: EvalSuiteSchema,
		config_name: nonEmptyString,
		created_at: Type.String({ minLength: 1, format: "date-time" }),
		context: Type.Optional(EvalRunContextSchema),
		results: Type.Array(EvalRunResultSchema),
		summary: EvalRunSummarySchema,
		verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
	},
	{ additionalProperties: false },
);

export type EvalSuite = (typeof EVAL_SUITES)[number];
export type EvalRiskTier = (typeof EVAL_RISK_TIERS)[number];
export type EvalJudgeType = (typeof EVAL_JUDGE_TYPES)[number];

export type EvalSource = {
	kind: string;
};

export type EvalPrivacy = {
	classification: string;
	sanitized: boolean;
};

export type EvalExpected = {
	success_criteria: string[];
};

export type FileExistsAssertion = {
	type: "file_exists";
	path: string;
};

export type DeterministicJudge = {
	type: "deterministic";
	assertions: FileExistsAssertion[];
};

export type LlmJudge = {
	type: "llm";
	rubric: string;
	model?: string;
};

export type HumanJudge = {
	type: "human";
	rubric: string;
	reviewer?: string;
};

export type EvalJudge = DeterministicJudge | LlmJudge | HumanJudge;

export type EvalCase = {
	schema_version: typeof EVAL_CASE_SCHEMA_VERSION;
	case_id: string;
	title: string;
	suite: EvalSuite;
	risk_tier: EvalRiskTier;
	task_type: string;
	source: EvalSource;
	privacy: EvalPrivacy;
	expected: EvalExpected;
	judge: EvalJudge;
};

export type EvalConfig = {
	schema_version: typeof EVAL_CONFIG_SCHEMA_VERSION;
	name: string;
	cases: EvalCase[];
};

export type EvalRunSummary = {
	total: number;
	passed: number;
	failed: number;
	critical_regressions: number;
};

export type EvalRunResult = {
	case_id: string;
	title: string;
	risk_tier: EvalRiskTier;
	critical: boolean;
	passed: boolean;
	privacy: EvalPrivacy;
	errors: string[];
};

export type EvalRunContext = {
	spec_slice?: string;
	session_id?: string;
	commit_range?: string;
	eval_report_path: string;
};

export type EvalRun = {
	schema_version: typeof EVAL_RUN_SCHEMA_VERSION;
	run_id: string;
	suite: EvalSuite;
	config_name: string;
	created_at: string;
	context?: EvalRunContext;
	results: EvalRunResult[];
	summary: EvalRunSummary;
	verdict: "pass" | "fail";
};

export type ValidationResult<T> =
	| { ok: true; value: T }
	| { ok: false; errors: string[] };

type ErrorSink = string[];

export function validateEvalConfig(
	value: unknown,
): ValidationResult<EvalConfig> {
	const errors: ErrorSink = [];
	if (!isRecord(value)) {
		return { ok: false, errors: ["$ must be an object"] };
	}

	rejectUnknownProperties(
		value,
		"$",
		["schema_version", "name", "cases"],
		errors,
	);
	requireLiteral(value, "schema_version", EVAL_CONFIG_SCHEMA_VERSION, errors);
	requireString(value, "name", errors);
	if (Array.isArray(value.cases)) {
		if (value.cases.length === 0) {
			errors.push("cases must contain at least one case");
		}
		value.cases.forEach((item, index) =>
			validateCaseInto(item, `cases[${index}]`, errors),
		);
	} else {
		errors.push("cases must be an array");
	}

	return finish(value, errors);
}

export function validateEvalCase(value: unknown): ValidationResult<EvalCase> {
	const errors: ErrorSink = [];
	validateCaseInto(value, "$", errors);
	return finish(value, errors);
}

export function validateEvalRun(value: unknown): ValidationResult<EvalRun> {
	const errors: ErrorSink = [];
	if (!isRecord(value)) {
		return { ok: false, errors: ["$ must be an object"] };
	}

	rejectUnknownProperties(
		value,
		"$",
		[
			"schema_version",
			"run_id",
			"suite",
			"config_name",
			"created_at",
			"context",
			"results",
			"summary",
			"verdict",
		],
		errors,
	);
	requireLiteral(value, "schema_version", EVAL_RUN_SCHEMA_VERSION, errors);
	requireString(value, "run_id", errors);
	requireOneOf(value, "suite", EVAL_SUITES, errors);
	requireString(value, "config_name", errors);
	requireIsoTimestamp(value, "created_at", errors);
	if (value.context !== undefined) {
		validateRunContext(value.context, "context", errors);
	}
	if (Array.isArray(value.results)) {
		value.results.forEach((item, index) =>
			validateRunResult(item, `results[${index}]`, errors),
		);
	} else {
		errors.push("results must be an array");
	}
	validateRunSummary(value.summary, "summary", errors);
	requireOneOf(value, "verdict", ["pass", "fail"], errors);

	return finish(value, errors);
}

function validateCaseInto(
	value: unknown,
	path: string,
	errors: ErrorSink,
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	rejectUnknownProperties(
		value,
		path,
		[
			"schema_version",
			"case_id",
			"title",
			"suite",
			"risk_tier",
			"task_type",
			"source",
			"privacy",
			"expected",
			"judge",
		],
		errors,
	);

	requireLiteral(
		value,
		joinPath(path, "schema_version"),
		EVAL_CASE_SCHEMA_VERSION,
		errors,
	);
	requireString(value, joinPath(path, "case_id"), errors);
	requireString(value, joinPath(path, "title"), errors);
	requireOneOf(value, joinPath(path, "suite"), EVAL_SUITES, errors);
	requireOneOf(value, joinPath(path, "risk_tier"), EVAL_RISK_TIERS, errors);
	requireString(value, joinPath(path, "task_type"), errors);
	validateSource(value.source, joinPath(path, "source"), errors);
	validatePrivacy(value.privacy, joinPath(path, "privacy"), errors);
	validateExpected(value.expected, joinPath(path, "expected"), errors);
	validateJudge(value.judge, joinPath(path, "judge"), errors);
}

function validateSource(value: unknown, path: string, errors: ErrorSink): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	requireString(value, joinPath(path, "kind"), errors);
}

function validatePrivacy(
	value: unknown,
	path: string,
	errors: ErrorSink,
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	rejectUnknownProperties(value, path, ["classification", "sanitized"], errors);
	requireString(value, joinPath(path, "classification"), errors);
	requireBoolean(value, joinPath(path, "sanitized"), errors);
}

function validateExpected(
	value: unknown,
	path: string,
	errors: ErrorSink,
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	rejectUnknownProperties(value, path, ["success_criteria"], errors);
	if (!Array.isArray(value.success_criteria)) {
		errors.push(`${joinPath(path, "success_criteria")} must be an array`);
		return;
	}
	if (value.success_criteria.length === 0) {
		errors.push(
			`${joinPath(path, "success_criteria")} must contain at least one criterion`,
		);
	}
	value.success_criteria.forEach((criterion, index) => {
		if (typeof criterion !== "string" || criterion.length === 0) {
			errors.push(
				`${joinPath(path, `success_criteria[${index}]`)} must be a non-empty string`,
			);
		}
	});
}

function validateJudge(value: unknown, path: string, errors: ErrorSink): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	requireOneOf(value, joinPath(path, "type"), EVAL_JUDGE_TYPES, errors);
	if (value.type === "deterministic") {
		rejectUnknownProperties(value, path, ["type", "assertions"], errors);
	}
	if (value.type === "llm") {
		rejectUnknownProperties(value, path, ["type", "rubric", "model"], errors);
		requireString(value, joinPath(path, "rubric"), errors);
		if (value.model !== undefined) {
			requireString(value, joinPath(path, "model"), errors);
		}
		return;
	}
	if (value.type === "human") {
		rejectUnknownProperties(
			value,
			path,
			["type", "rubric", "reviewer"],
			errors,
		);
		requireString(value, joinPath(path, "rubric"), errors);
		if (value.reviewer !== undefined) {
			requireString(value, joinPath(path, "reviewer"), errors);
		}
		return;
	}
	if (value.type !== "deterministic") {
		return;
	}
	if (!Array.isArray(value.assertions)) {
		errors.push(`${joinPath(path, "assertions")} must be an array`);
		return;
	}
	if (value.assertions.length === 0) {
		errors.push(
			`${joinPath(path, "assertions")} must contain at least one assertion`,
		);
	}
	value.assertions.forEach((assertion, index) => {
		validateFileExistsAssertion(
			assertion,
			joinPath(path, `assertions[${index}]`),
			errors,
		);
	});
}

function validateFileExistsAssertion(
	value: unknown,
	path: string,
	errors: ErrorSink,
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	rejectUnknownProperties(value, path, ["type", "path"], errors);
	requireLiteral(value, joinPath(path, "type"), "file_exists", errors);
	requireString(value, joinPath(path, "path"), errors);
}

function validateRunResult(
	value: unknown,
	path: string,
	errors: ErrorSink,
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	rejectUnknownProperties(
		value,
		path,
		[
			"case_id",
			"title",
			"risk_tier",
			"critical",
			"passed",
			"privacy",
			"errors",
		],
		errors,
	);
	requireString(value, joinPath(path, "case_id"), errors);
	requireString(value, joinPath(path, "title"), errors);
	requireOneOf(value, joinPath(path, "risk_tier"), EVAL_RISK_TIERS, errors);
	requireBoolean(value, joinPath(path, "critical"), errors);
	requireBoolean(value, joinPath(path, "passed"), errors);
	validatePrivacy(value.privacy, joinPath(path, "privacy"), errors);
	if (!Array.isArray(value.errors)) {
		errors.push(`${joinPath(path, "errors")} must be an array`);
		return;
	}
	value.errors.forEach((message, index) => {
		if (typeof message !== "string") {
			errors.push(`${joinPath(path, `errors[${index}]`)} must be a string`);
		}
	});
}

function validateRunContext(
	value: unknown,
	path: string,
	errors: ErrorSink,
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	rejectUnknownProperties(
		value,
		path,
		["spec_slice", "session_id", "commit_range", "eval_report_path"],
		errors,
	);
	for (const field of ["spec_slice", "session_id", "commit_range"]) {
		if (value[field] !== undefined) {
			requireString(value, joinPath(path, field), errors);
		}
	}
	requireString(value, joinPath(path, "eval_report_path"), errors);
}

function validateRunSummary(
	value: unknown,
	path: string,
	errors: ErrorSink,
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	rejectUnknownProperties(
		value,
		path,
		["total", "passed", "failed", "critical_regressions"],
		errors,
	);
	requireNonNegativeInteger(value, joinPath(path, "total"), errors);
	requireNonNegativeInteger(value, joinPath(path, "passed"), errors);
	requireNonNegativeInteger(value, joinPath(path, "failed"), errors);
	requireNonNegativeInteger(
		value,
		joinPath(path, "critical_regressions"),
		errors,
	);
}

function requireString(
	value: Record<string, unknown>,
	path: string,
	errors: ErrorSink,
): void {
	const field = fieldName(path);
	if (typeof value[field] !== "string" || value[field].length === 0) {
		errors.push(`${path} must be a non-empty string`);
	}
}

function requireIsoTimestamp(
	value: Record<string, unknown>,
	path: string,
	errors: ErrorSink,
): void {
	const field = fieldName(path);
	const timestamp = value[field];
	if (typeof timestamp !== "string" || timestamp.length === 0) {
		errors.push(`${path} must be a non-empty string`);
		return;
	}
	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
		errors.push(`${path} must be an ISO timestamp`);
	}
}

function requireBoolean(
	value: Record<string, unknown>,
	path: string,
	errors: ErrorSink,
): void {
	const field = fieldName(path);
	if (typeof value[field] !== "boolean") {
		errors.push(`${path} must be a boolean`);
	}
}

function requireLiteral<T extends string>(
	value: Record<string, unknown>,
	path: string,
	expected: T,
	errors: ErrorSink,
): void {
	const field = fieldName(path);
	if (value[field] !== expected) {
		errors.push(`${path} must be ${expected}`);
	}
}

function requireOneOf<const T extends readonly string[]>(
	value: Record<string, unknown>,
	path: string,
	allowed: T,
	errors: ErrorSink,
): void {
	const field = fieldName(path);
	if (typeof value[field] !== "string" || !allowed.includes(value[field])) {
		errors.push(`${path} must be one of: ${allowed.join(", ")}`);
	}
}

function requireNonNegativeInteger(
	value: Record<string, unknown>,
	path: string,
	errors: ErrorSink,
): void {
	const field = fieldName(path);
	if (!Number.isInteger(value[field]) || (value[field] as number) < 0) {
		errors.push(`${path} must be a non-negative integer`);
	}
}

function rejectUnknownProperties(
	value: Record<string, unknown>,
	path: string,
	allowed: readonly string[],
	errors: ErrorSink,
): void {
	for (const key of Object.keys(value)) {
		if (allowed.includes(key)) {
			continue;
		}
		const prefix = path === "$" ? "" : `${path} `;
		errors.push(`${prefix}unexpected property: ${key}`);
	}
}

function finish<T>(value: unknown, errors: ErrorSink): ValidationResult<T> {
	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true, value: value as T };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinPath(base: string, field: string): string {
	return base === "$" ? field : `${base}.${field}`;
}

function fieldName(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? path : path.slice(dot + 1);
}
