# i-have-adhd OMP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a session-persistent, opt-in ADHD-friendly output mode to OMP Pantheon without coupling it to the `oh-my-omp` autonomy runtime.

**Architecture:** Ship the upstream MIT skill as an OMP-discovered skill and implement its stateful behavior in a separate extension package. The extension imports OMP only for types, so its runtime module graph contains no `@oh-my-pi/*` packages; it uses only the public `ExtensionAPI` methods supplied by OMP.

**Tech Stack:** TypeScript ES modules, Bun tests, OMP public extension API, Markdown Agent Skills.

**Spec:** User-approved in-chat design: isolated `extensions/i-have-adhd/` package; `/i-have-adhd [on|off]`, `--adhd`, session persistence, compaction recovery, optional agent-directory flag, and no dependency on `oh-my-omp` internals.

## Global Constraints

- Keep `extensions/i-have-adhd/` independent of `extensions/oh-my-omp/`.
- Import `@oh-my-pi/pi-coding-agent` only with `import type`; no executable package imports are allowed.
- Use only documented OMP extension API methods: `on`, `registerFlag`, `registerCommand`, `appendEntry`, `sendMessage`, `getFlag`, `ctx.sessionManager.getBranch`, and `ctx.ui`.
- Preserve upstream MIT copyright and license notice with the copied skill content.
- Keep the mode opt-in by default; `--adhd` and `.i-have-adhd-always` are explicit opt-ins.
- Retain harness safety and verification rules over output-style rules when they conflict.

---

### Task 1: Add the independent OMP extension

**Files:**
- Create: `extensions/i-have-adhd/package.json`
- Create: `extensions/i-have-adhd/tsconfig.json`
- Create: `extensions/i-have-adhd/index.ts`
- Modify: `package.json:7-14`

**Interfaces:**
- Consumes: OMP's public `ExtensionAPI` and `ExtensionContext` types.
- Produces: package-discoverable `index.ts` default extension factory and the `i-have-adhd` command/`adhd` flag.

- [ ] **Step 1: Write the failing extension contract tests from Task 2 before implementation.**
- [ ] **Step 2: Create `extensions/i-have-adhd/package.json` with the discovery entry.**

```json
{
  "name": "i-have-adhd",
  "private": true,
  "type": "module",
  "omp": { "extensions": ["./index.ts"] }
}
```

- [ ] **Step 3: Create `extensions/i-have-adhd/tsconfig.json` extending the repository compiler options and including `index.ts`.**
- [ ] **Step 4: Implement the extension.**

```ts
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export default function registerIHaveAdhd(pi: ExtensionAPI): void {
  pi.registerFlag("adhd", { type: "boolean", default: false, description: "Start with ADHD-friendly output enabled" });
  pi.registerCommand("i-have-adhd", { description: "Toggle ADHD-friendly output for this session", handler: async () => {} });
  pi.on("session_start", async (_event, ctx) => { /* restore persisted state */ });
  pi.on("session_tree", async (_event, ctx) => { /* restore branch state */ });
  pi.on("session_compact", async (_event, ctx) => { /* reinject rules after compaction */ });
  pi.on("input", async (event, ctx) => { /* alias and stop phrases */ });
}
```

Implement `getSavedState` by selecting the last `custom` entry whose `customType` is `i-have-adhd-state`. Determine whether rules remain live by scanning `ctx.sessionManager.getBranch()` in order: a rules message enables the marker, a disabled message or later compaction clears it. Call `pi.sendMessage` with `display: false` only if state and marker disagree. Write the always-on sentinel under `process.env.PI_CODING_AGENT_DIR ?? ~/.omp/agent`, avoiding `getAgentDir()` because it is a runtime import of `pi-utils`.

- [ ] **Step 5: Add `extensions/i-have-adhd` to the root `typecheck` script.**

```json
"typecheck": "tsc --noEmit && (cd extensions/oh-my-omp && bun run typecheck) && (cd extensions/i-have-adhd && bun run typecheck)"
```

- [ ] **Step 6: Run `bun run typecheck`.**

Expected: PASS, including the new extension package.

### Task 2: Lock the OMP integration contract

**Files:**
- Create: `test/i-have-adhd-extension.test.ts`

**Interfaces:**
- Consumes: `extensions/i-have-adhd/index.ts` default factory.
- Produces: regression coverage for public-API-only registration, state restoration, command transitions, compaction recovery, and stop phrases.

- [ ] **Step 1: Build a fake `ExtensionAPI` that records handlers, flags, commands, `appendEntry`, `sendMessage`, and `getFlag`.**
- [ ] **Step 2: Build a fake `ExtensionContext` with a branch, `hasUI`, and `ui.setStatus`/`ui.notify`.**
- [ ] **Step 3: Test first session start.**

```ts
test("enables from --adhd and injects the rules once", async () => {
  const harness = createExtensionHarness({ adhd: true });
  await harness.handlers.session_start?.({}, harness.ctx);
  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0]?.customType).toBe("i-have-adhd-rules");
  expect(harness.statuses).toContain("● ADHD ON");
});
```

- [ ] **Step 4: Test the command records state and injects/removes context markers.**
- [ ] **Step 5: Test a persisted enabled state is restored from `getBranch()`.**
- [ ] **Step 6: Test `session_compact` reinjects rules when enabled.**
- [ ] **Step 7: Test `/skill:i-have-adhd` and `stop adhd mode` intercept input and update state.**
- [ ] **Step 8: Run `bun test test/i-have-adhd-extension.test.ts`.**

Expected: PASS with no import of `@oh-my-pi/pi-utils` at runtime.

### Task 3: Vendor the skill with legal attribution

**Files:**
- Create: `skills/i-have-adhd/SKILL.md`
- Create: `skills/i-have-adhd/LICENSE`
- Modify: `ATTRIBUTION.md:8-32`

**Interfaces:**
- Consumes: upstream `ayghri/i-have-adhd` MIT-licensed skill text.
- Produces: OMP-discoverable Agent Skill whose command alias is coordinated by the extension.

- [ ] **Step 1: Copy the upstream skill text into `skills/i-have-adhd/SKILL.md`, preserving its `disable-model-invocation: true` opt-in default.**
- [ ] **Step 2: Copy the full upstream MIT license into `skills/i-have-adhd/LICENSE`.**
- [ ] **Step 3: Add an `i-have-adhd` source entry to `ATTRIBUTION.md`, naming Ayoub Ghriss, the upstream URL, the MIT license, and the separate OMP adaptation in `extensions/i-have-adhd/`.**
- [ ] **Step 4: Run `bun test test/i-have-adhd-extension.test.ts`.**

Expected: PASS; copied text and code retain their notices.

### Task 4: Document discovery and verify the full bundle

**Files:**
- Modify: `README.md:103-139`

**Interfaces:**
- Consumes: installer behavior that symlinks each directory under `extensions/` and `skills/`.
- Produces: accurate public inventory of the optional ADHD-friendly output mode.

- [ ] **Step 1: Add one capability bullet to the README: opt-in `/i-have-adhd` session-persistent output mode with `--adhd` and agent-directory sentinel support.**
- [ ] **Step 2: Run `bun test`.**
- [ ] **Step 3: Run `bun run typecheck`.**
- [ ] **Step 4: Exercise the installed extension loader without a model request.**

```bash
omp --no-session -p --max-time=1 "Reply only: loaded"
```

Expected: no `Failed to load extension` warning for `i-have-adhd`.

- [ ] **Step 5: Review the changed files and confirm no executable import references `@oh-my-pi/pi-utils`, `launch/`, or `extensions/oh-my-omp/`.**
