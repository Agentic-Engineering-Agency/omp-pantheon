# Progressive Skill Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the complete OMP skill catalog in a dedicated model call, then give the execution model only the applicable catalog entries without changing any other OMP behavior.

**Architecture:** A pure catalog parser preserves the original `<skills>` bytes; a model-backed router returns strictly validated skill names; a `before_agent_start` runtime unions those names with earlier session selections and replaces only that block. Every parser, model, credential, timeout, or validation failure returns the exact original system prompt.

**Tech Stack:** TypeScript ES modules, Bun, `@oh-my-pi/pi-coding-agent` extension API, `@oh-my-pi/pi-ai`, Bun test, EvalFly deterministic repository checks.

**Spec:** `docs/superpowers/specs/2026-08-19-progressive-skill-routing-design.md`

## Global Constraints

- OMP remains the source of truth for discovered skills and their rendered order.
- Every existing `skill://<name>` URI and manual skill command remains available.
- Only the `<skills>` block in the first system-prompt segment may change.
- Any uncertain, malformed, timed-out, or failed route returns the original prompt.
- Previously selected skills remain visible for the rest of the session.
- Router logs contain reasons and counts only; never prompt text, descriptions, responses, or credentials.
- No global OMP configuration is read differently or mutated.
- Each implementation task ends in an atomic commit and approved push.

## File Map

- Create `extensions/oh-my-omp/skill-routing/catalog.ts`: exact catalog parsing, validation, and byte-preserving selection.
- Create `extensions/oh-my-omp/skill-routing/router.ts`: model completion, strict response validation, timeout, and injected test seam.
- Create `extensions/oh-my-omp/skill-routing/runtime.ts`: per-session accumulation and `before_agent_start` registration.
- Modify `extensions/oh-my-omp/index.ts`: register the transparent routing runtime without changing resource discovery.
- Modify `extensions/oh-my-omp/package.json` and `extensions/oh-my-omp/bun.lock`: declare the direct `@oh-my-pi/pi-ai` dependency at `17.2.14`.
- Create `test/skill-routing.test.ts`: parser, router, runtime, privacy, and entrypoint contract tests.
- Modify `evals/config.json` and `test/evalfly-project-repo.test.ts`: add and synchronize the routing regression contract.
- Modify `docs/harness-overview.md`: document the transparent router, failure behavior, and measurement procedure.

---

### Task 1: Byte-Preserving Skill Catalog

**Files:**
- Create: `extensions/oh-my-omp/skill-routing/catalog.ts`
- Test: `test/skill-routing.test.ts`

**Interfaces:**
- Consumes: OMP `before_agent_start` `systemPrompt: string[]`.
- Produces: `parseSkillCatalog(systemPrompt: readonly string[]): ParsedSkillCatalog | undefined`.
- Produces: `ParsedSkillCatalog.render(selectedNames: ReadonlySet<string>): string[]`.
- Produces: `SkillCatalogEntry { name: string; description: string; line: string }`.

- [ ] **Step 1: Write failing parser tests**

Cover a two-segment prompt, exact preservation outside the catalog, stable original ordering, empty selection, malformed lines, duplicate names, missing markers, nested markers, and an empty catalog.

```ts
import { describe, expect, test } from "bun:test";
import { parseSkillCatalog } from "../extensions/oh-my-omp/skill-routing/catalog";

const SYSTEM_PROMPT = [
  [
    "ROLE",
    "<skills>",
    "- diagnose: Diagnose failures before editing.",
    "- git-master: Handle every git operation.",
    "- review-work: Review completed implementation.",
    "</skills>",
    "TOOLS",
  ].join("\n"),
  "PROJECT CONTEXT",
];

test("renders selected original lines and preserves every other byte", () => {
  const catalog = parseSkillCatalog(SYSTEM_PROMPT);
  expect(catalog).toBeDefined();
  expect(catalog?.render(new Set(["git-master", "diagnose"]))).toEqual([
    [
      "ROLE",
      "<skills>",
      "- diagnose: Diagnose failures before editing.",
      "- git-master: Handle every git operation.",
      "</skills>",
      "TOOLS",
    ].join("\n"),
    "PROJECT CONTEXT",
  ]);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test test/skill-routing.test.ts`

Expected: FAIL because `skill-routing/catalog.ts` does not exist.

- [ ] **Step 3: Implement the exact parser**

Use these public types and reject rather than repair malformed input:

```ts
export interface SkillCatalogEntry {
  name: string;
  description: string;
  line: string;
}

export interface ParsedSkillCatalog {
  entries: readonly SkillCatalogEntry[];
  render(selectedNames: ReadonlySet<string>): string[];
}

export function parseSkillCatalog(
  systemPrompt: readonly string[],
): ParsedSkillCatalog | undefined;
```

Implementation rules:

- require exactly one `<skills>` and one `</skills>` marker in segment zero;
- require the closing marker after the opening marker;
- parse each interior line with `/^- ([^:\n]+): (.+)$/`;
- reject blank, duplicate, or malformed names;
- reject zero entries;
- capture each full original line;
- render by filtering original lines in original order;
- return copied prompt arrays and never mutate the event input.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test test/skill-routing.test.ts && bun run typecheck`

Expected: all parser tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit and push atomically**

```bash
git add extensions/oh-my-omp/skill-routing/catalog.ts test/skill-routing.test.ts
git commit -m "feat(skill-routing): preserve compact catalog bytes" -m "Spec-Slice: context-pointer-skills"
skill://push/bin/push.sh
skill://push/bin/push.sh --i-approve
```

---

### Task 2: Strict Active-Model Router

**Files:**
- Create: `extensions/oh-my-omp/skill-routing/router.ts`
- Modify: `extensions/oh-my-omp/package.json`
- Modify: `extensions/oh-my-omp/bun.lock`
- Test: `test/skill-routing.test.ts`

**Interfaces:**
- Consumes: `SkillCatalogEntry[]`, user prompt, previously selected names, active OMP model, and model-registry credential resolver.
- Produces: `SkillRoutingDecision = { kind: "selected"; names: readonly string[] } | { kind: "fallback"; reason: SkillRoutingFailureReason }`.
- Produces: `routeSkills(input: RouteSkillsInput, dependencies: RouteSkillsDependencies): Promise<SkillRoutingDecision>`.
- Test seam: `complete` is injected with the same call signature used by `@oh-my-pi/pi-ai.complete`.

- [ ] **Step 1: Write failing validation and completion tests**

Add tests for valid multiple selection, certain empty selection, surrounding prose, invalid JSON, unknown names, duplicates, `uncertain`, missing model, missing credentials, provider rejection, and timeout.

```ts
test("accepts only certain known unique skill names", async () => {
  const decision = await routeSkills(
    {
      prompt: "Diagnose this failure, then commit it",
      entries: CATALOG_ENTRIES,
      previousNames: new Set<string>(),
      model: MODEL,
      getApiKey: async () => "credential",
    },
    {
      complete: async () => response('{"skills":["diagnose","git-master"],"confidence":"certain"}'),
      timeoutMs: 50,
    },
  );
  expect(decision).toEqual({ kind: "selected", names: ["diagnose", "git-master"] });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test test/skill-routing.test.ts`

Expected: FAIL because `skill-routing/router.ts` does not exist.

- [ ] **Step 3: Declare the direct model dependency**

In `extensions/oh-my-omp/package.json`, add:

```json
"dependencies": {
  "@oh-my-pi/pi-ai": "17.2.14"
}
```

Run `bun install` from `extensions/oh-my-omp` to update its lockfile without upgrading unrelated packages.

- [ ] **Step 4: Implement the router**

Use a JSON-only instruction containing the complete catalog and the exact output schema. Call `complete(model, context, { apiKey, maxTokens: 512, signal })`, where `signal` is bounded by `AbortSignal.timeout(timeoutMs)`.

```ts
export type SkillRoutingFailureReason =
  | "no-model"
  | "no-credential"
  | "timeout"
  | "provider-error"
  | "invalid-response"
  | "uncertain";

export type SkillRoutingDecision =
  | { kind: "selected"; names: readonly string[] }
  | { kind: "fallback"; reason: SkillRoutingFailureReason };
```

Extract exactly one text block, parse it with `JSON.parse`, validate exact object keys, require `confidence === "certain"`, validate every name against the catalog set, and reject duplicates. Do not log inside this pure routing unit.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test test/skill-routing.test.ts && bun run typecheck`

Expected: router tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit and push atomically**

The four files are inseparable because the production router, its direct dependency declaration/lock, and its behavioral tests must resolve together.

```bash
git add extensions/oh-my-omp/skill-routing/router.ts extensions/oh-my-omp/package.json extensions/oh-my-omp/bun.lock test/skill-routing.test.ts
git commit -m "feat(skill-routing): select skills with active model" -m "Spec-Slice: context-pointer-skills"
skill://push/bin/push.sh
skill://push/bin/push.sh --i-approve
```

---

### Task 3: Fail-Open Session Runtime

**Files:**
- Create: `extensions/oh-my-omp/skill-routing/runtime.ts`
- Modify: `extensions/oh-my-omp/index.ts`
- Test: `test/skill-routing.test.ts`

**Interfaces:**
- Consumes: `ExtensionAPI`, `parseSkillCatalog`, and `routeSkills`.
- Produces: `registerSkillRouting(pi: ExtensionAPI, options?: SkillRoutingRuntimeOptions): void`.
- Test seam: `SkillRoutingRuntimeOptions.route` can inject a deterministic router; production defaults to `routeSkills`.

- [ ] **Step 1: Write failing runtime tests**

Cover handler registration, selected rendering, accumulation across two turns, catalog-order rendering, exact fallback, no mutation of event input, metadata-only debug logs, and `session_shutdown` clearing accumulated names.

```ts
test("accumulates selections while replacing only the catalog", async () => {
  const runtime = createRoutingHarness([
    { kind: "selected", names: ["diagnose"] },
    { kind: "selected", names: ["git-master"] },
  ]);
  const first = await runtime.beforeAgentStart({ prompt: "debug", systemPrompt: SYSTEM_PROMPT });
  const second = await runtime.beforeAgentStart({ prompt: "commit", systemPrompt: SYSTEM_PROMPT });
  expect(first.systemPrompt?.[0]).toContain("- diagnose:");
  expect(second.systemPrompt?.[0]).toContain("- diagnose:");
  expect(second.systemPrompt?.[0]).toContain("- git-master:");
});
```

Update the existing Pantheon entrypoint contract to assert one `before_agent_start` handler is registered without changing commands, tools, or `resources_discover` output.

- [ ] **Step 2: Run focused integration tests and confirm RED**

Run: `bun test test/skill-routing.test.ts test/autonomy-extension.test.ts`

Expected: FAIL because the runtime and entrypoint registration do not exist.

- [ ] **Step 3: Implement and register the runtime**

Use a closure-owned `Set<string>` for session selections. The handler must:

```ts
pi.on("before_agent_start", async (event, ctx) => {
  const catalog = parseSkillCatalog(event.systemPrompt);
  if (!catalog) return { systemPrompt: event.systemPrompt };

  const decision = await routeSkills({
    prompt: event.prompt,
    entries: catalog.entries,
    previousNames: selectedNames,
    model: ctx.model,
    getApiKey: async (model, signal) =>
      ctx.modelRegistry.getApiKey(model, ctx.sessionManager.getSessionId(), { signal }),
  });
  if (decision.kind === "fallback") return { systemPrompt: event.systemPrompt };

  for (const name of decision.names) selectedNames.add(name);
  return { systemPrompt: catalog.render(selectedNames) };
});
```

Register a `session_shutdown` handler that clears the set. Log only `{ reason, catalogCount, selectedCount }`. Add `registerSkillRouting(pi)` to `index.ts` without modifying its existing `resources_discover` callback.

- [ ] **Step 4: Run focused tests, full tests, and typecheck**

Run:

```bash
bun test test/skill-routing.test.ts test/autonomy-extension.test.ts
bun test
bun run typecheck
```

Expected: focused and full suites PASS; typecheck exits 0.

- [ ] **Step 5: Commit and push atomically**

The runtime, its entrypoint registration, and integration tests form one executable contract and cannot be separated without leaving the extension incomplete.

```bash
git add extensions/oh-my-omp/skill-routing/runtime.ts extensions/oh-my-omp/index.ts test/skill-routing.test.ts
git commit -m "feat(extension): route skill context before execution" -m "Spec-Slice: context-pointer-skills"
skill://push/bin/push.sh
skill://push/bin/push.sh --i-approve
```

---

### Task 4: EvalFly Regression Contract

**Files:**
- Modify: `evals/config.json`
- Modify: `test/evalfly-project-repo.test.ts`

**Interfaces:**
- Consumes: the implemented routing runtime and regression test paths.
- Produces: deterministic case `progressive-skill-routing-regression-exists` synchronized with the repository contract test.

- [ ] **Step 1: Write the failing EvalFly synchronization expectation**

Add the case ID to the exact expected case list in `test/evalfly-project-repo.test.ts` before modifying the config.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `bun test test/evalfly-project-repo.test.ts`

Expected: FAIL because `evals/config.json` lacks `progressive-skill-routing-regression-exists`.

- [ ] **Step 3: Add the deterministic EvalFly case**

Append a critical `test_contract` case with two `file_exists` assertions:

```json
{
  "schema_version": "evalfly.case.v1",
  "case_id": "progressive-skill-routing-regression-exists",
  "title": "Progressive skill routing regression suite exists",
  "suite": "smoke",
  "risk_tier": "critical",
  "task_type": "test_contract",
  "source": { "kind": "project_eval_repo" },
  "privacy": { "classification": "public", "sanitized": true },
  "expected": {
    "success_criteria": [
      "The skill-routing runtime and behavioral regression suite exist; behavioral assertions execute in the Bun suite."
    ]
  },
  "judge": {
    "type": "deterministic",
    "assertions": [
      { "type": "file_exists", "path": "extensions/oh-my-omp/skill-routing/runtime.ts" },
      { "type": "file_exists", "path": "test/skill-routing.test.ts" }
    ]
  }
}
```

- [ ] **Step 4: Run EvalFly and repository tests**

Run:

```bash
bun test test/evalfly-project-repo.test.ts test/skill-routing.test.ts
bun run skills/evalfly/bin/evalfly.ts run --suite smoke
bun run skills/evalfly/bin/evalfly.ts check
```

Expected: tests PASS; EvalFly run and check produce passing matching evidence.

- [ ] **Step 5: Commit and push atomically**

```bash
git add evals/config.json test/evalfly-project-repo.test.ts
git commit -m "test: protect progressive skill routing" -m "Spec-Slice: context-pointer-skills"
skill://push/bin/push.sh
skill://push/bin/push.sh --i-approve
```

---

### Task 5: Operational Documentation

**Files:**
- Modify: `docs/harness-overview.md`

**Interfaces:**
- Consumes: final runtime behavior and measured token evidence.
- Produces: operator-facing explanation of routing, fallback, diagnostics, and reproducible measurement commands.

- [ ] **Step 1: Add the routing section**

Document:

- OMP still discovers every skill and retains the full active registry;
- Pantheon routes the rendered catalog before the execution turn;
- certain selections are cumulative per session;
- every routing failure restores the original prompt;
- no global config is changed;
- debug logs contain counts/reasons only;
- baseline and comparison commands use a fixed prompt, model, CWD, and fresh ephemeral session.

Include the measured baseline table from the spec and distinguish estimated system-prompt tokens from provider usage, which can be distorted by server-side prompt caching.

- [ ] **Step 2: Run formatting and documentation-linked tests**

Run:

```bash
bun run format:check
bun test test/evalfly-project-repo.test.ts
```

Expected: formatting and test PASS.

- [ ] **Step 3: Commit and push atomically**

```bash
git add docs/harness-overview.md
git commit -m "docs: explain progressive skill routing" -m "Spec-Slice: context-pointer-skills"
skill://push/bin/push.sh
skill://push/bin/push.sh --i-approve
```

---

### Task 6: End-to-End Verification and PR Evidence

**Files:**
- Modify only if evidence exposes a defect: the owning implementation file and its direct test.
- Update PR #35 body after all checks pass; do not commit generated private logs or raw traces.

**Interfaces:**
- Consumes: installed worktree extension, fixed probe prompts, Bun suite, EvalFly report.
- Produces: exact verification evidence and final draft-PR description.

- [ ] **Step 1: Run release gates**

Run:

```bash
bun test
bun run typecheck
bun run format:check
bun run lint
```

Expected: all commands exit 0.

- [ ] **Step 2: Exercise installation without overwriting the external tree**

Run:

```bash
temp_home="$(mktemp -d)"
HOME="$temp_home" \
AGENT_DIR="$temp_home/.omp/agent" \
BACKUP_DIR="$temp_home/.omp/agent-backups/install" \
./install.sh
test -L "$temp_home/.omp/agent/extensions/oh-my-omp"
test -f "$temp_home/.omp/agent/extensions/oh-my-omp/skill-routing/runtime.ts"
test -L "$temp_home/.omp/agent/skills/using-superpowers"
rm -rf "$temp_home"
```

Expected: installer exits 0; the extension and unchanged skill bundle are symlinked only inside the temporary tree. `rm -rf` is restricted to the path returned by `mktemp -d`; print and inspect `temp_home` before cleanup if the command is run manually.

- [ ] **Step 3: Run representative routing scenarios**

Use fixed prompts for single skill, multiple skills, mandatory process plus domain skill, no skill, ambiguity/fallback, and task switching. Inspect the resulting `skill://` reads or sanitized EvalFly trace evidence, not router prompt contents.

Acceptance:

- deterministic cases select the same skill-name set as the full-catalog baseline;
- ambiguous cases use the original full prompt;
- task switching retains prior selected entries;
- `skill://` reads still resolve.

- [ ] **Step 4: Record context evidence**

Record full and routed catalog counts and estimated tokens using OMP's native estimator or the same tokenizer helper. Record a digest of the non-skill prompt before and after; digests must match. Do not use provider `usage.input` alone because cached-token reporting can hide the catalog delta.

- [ ] **Step 5: Run final engineering review**

Invoke `review-work` and resolve every correctness, compatibility, privacy, or reliability finding. Re-run only the affected focused tests after a fix, then rerun the four release gates once.

- [ ] **Step 6: Update draft PR #35**

Add:

- problem and architecture;
- before/after catalog token evidence;
- exact fallback guarantees;
- exact verification commands and outcomes;
- EvalFly run/report references;
- known cost/latency trade-off of the dedicated routing call.

Keep the PR draft until review findings and all gates pass.
