# Prime Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Prime Agent's useful long-running autonomy and continual-refinement capabilities to OMP Pantheon without forking OMP, duplicating existing OMP primitives, or weakening Pantheon's verification gates.

**Architecture:** Pantheon remains an OMP extension and policy layer. A new autonomy controller owns durable goal state, schedules resumptions, and refuses completion until objective gates pass. A supervised `pantheon-agentd` worker resumes file-backed OMP sessions through the public SDK and reuses OMP's launch broker for process lifecycle. Refinements are proposals in an append-only ledger, not self-modifying code. Python-backed skills run through isolated, reproducible environments. OMP-native goals, eval kernels, Task/Hub, MCP, SDK sessions, and the launch broker remain the source of truth.

**Tech Stack:** TypeScript 6, Bun, `@oh-my-pi/pi-coding-agent` 17.2.14, OMP extension hooks and SDK, TypeBox, JSONL journals, Bun tests, Biome, EvalFly, SpecSafe.

---

## Global constraints

- Preserve OMP's existing discovery contracts for agents, skills, commands, hooks, extensions, and MCP servers.
- Keep all new autonomy opt-in and project-scoped, with operational state in private per-user storage. Default OMP/Pantheon behavior must remain unchanged.
- Replace the Ralph/ULW loop runtime; do not keep two competing autonomous-loop conventions.
- Treat model text, completion promises, and agent self-assessment as evidence only. They can never satisfy a completion gate by themselves.
- Reuse OMP native goals, SDK sessions, `eval`, `agent`, Task/Hub, and the launch broker. Do not copy Prime's single-notebook tool surface or fork its Pi packages.
- Never deserialize executable checkpoint payloads. Persist JSON-compatible values plus metadata and reject unsupported values.
- Keep refinements append-only, attributable, reversible, conflict-checked, and approval-gated before activation.
- Use temporary project roots and clocks in tests. Never mutate global `~/.omp` state.
- Each implementation task follows red-green-refactor, ends its SpecSafe slice, commits with a `Spec-Slice:` trailer, and pushes through `skills/push/bin/push.sh`.

---

## Target file structure

Create or modify these units:

- Modify: `package.json`, `extensions/oh-my-omp/package.json`, `bun.lock` — align the extension contract with OMP 17.2.14.
- Create: `test/omp-version-contract.test.ts` — prevent root/extension dependency drift.
- Create: `extensions/oh-my-omp/autonomy/types.ts` — durable goal, gate, attempt, schedule, and worker contracts.
- Create: `extensions/oh-my-omp/autonomy/store.ts` — atomic private per-user state and append-only event journal.
- Create: `extensions/oh-my-omp/autonomy/controller.ts` — state transitions and completion-gate decisions.
- Create: `extensions/oh-my-omp/autonomy/scheduler.ts` — persisted deadlines, lease claims, coalescing, and retry policy.
- Create: `extensions/oh-my-omp/autonomy/agentd.ts` — resident SDK worker resumed by the OMP launch broker.
- Create: `extensions/oh-my-omp/autonomy/checkpoints.ts` — safe kernel-checkpoint capability adapter.
- Create: `extensions/oh-my-omp/autonomy/retained-agents.ts` — retained-subagent capability adapter.
- Create: `extensions/oh-my-omp/autonomy/commands.ts` — `/autonomy` start/status/pause/resume/cancel/explain UX.
- Create: `extensions/oh-my-omp/refinement/ledger.ts` — proposal, approval, activation, rollback, conflict, and quarantine ledger.
- Create: `extensions/oh-my-omp/python-skills/manifest.ts` — declarative Python runtime contract and validation.
- Create: `extensions/oh-my-omp/python-skills/environment.ts` — private per-user content-addressed virtualenv provisioning with locks.
- Create: `extensions/oh-my-omp/python-skills/runner.ts` — bounded JSON request/response subprocess runner.
- Modify: `extensions/oh-my-omp/index.ts` — register the new controller and commands after tests pass.
- Remove: `extensions/oh-my-omp/loop/runtime.ts`, `state.ts`, `commands.ts`, `promise-detector.ts` — clean cutover from Ralph/ULW.
- Modify: `package.json`, `tsconfig.json` — include every new source directory in typecheck, format, and lint.
- Create tests under `test/` matching each contract below.
- Modify: `README.md`, `docs/harness-overview.md`, `ATTRIBUTION.md`, `UPDATE-LOG.md` — document opt-in usage, safety model, migration, and Prime attribution.

---

### Task 1: OMP 17 dependency contract

**Files:**
- Create: `test/omp-version-contract.test.ts`
- Modify: `package.json`
- Modify: `extensions/oh-my-omp/package.json`
- Modify: `bun.lock`

- [ ] Write a test that reads both package manifests and requires the same `@oh-my-pi/pi-coding-agent` range, `^17.2.14`.
- [ ] Run `bun test test/omp-version-contract.test.ts`; verify failure against the current 16.x manifests.
- [ ] Update both manifests and regenerate `bun.lock` with `bun install`.
- [ ] Re-run the targeted test and `bun run typecheck`.

### Task 2: Durable autonomy state machine

**Files:**
- Create: `extensions/oh-my-omp/autonomy/types.ts`
- Create: `extensions/oh-my-omp/autonomy/store.ts`
- Create: `extensions/oh-my-omp/autonomy/controller.ts`
- Create: `test/autonomy-controller.test.ts`

- [ ] Test explicit states: `idle`, `running`, `waiting`, `paused`, `succeeded`, `failed`, and `cancelled`.
- [ ] Test legal transitions, idempotent command IDs, stale-version rejection, and terminal-state immutability.
- [ ] Test that a model completion promise cannot finish a run.
- [ ] Test that success requires every configured gate to record `pass` for the current attempt and artifact revision.
- [ ] Implement typed state and gate records with monotonically increasing revisions.
- [ ] Persist state by write-to-temp plus atomic rename; append transition events with sequence numbers and checksums.
- [ ] Recover from the latest valid snapshot plus journal suffix; reject a corrupt or non-contiguous journal.
- [ ] Run `bun test test/autonomy-controller.test.ts` and `bun run typecheck`.

### Task 3: Gate adapters and clean loop cutover

**Files:**
- Create: `extensions/oh-my-omp/autonomy/gates.ts`
- Create: `extensions/oh-my-omp/specsafe-receipts.ts`
- Create: `extensions/oh-my-omp/private-state.ts`
- Create: `extensions/oh-my-omp/autonomy/commands.ts`
- Modify: `extensions/oh-my-omp/index.ts`
- Remove: `extensions/oh-my-omp/loop/runtime.ts`
- Remove: `extensions/oh-my-omp/loop/state.ts`
- Remove: `extensions/oh-my-omp/loop/commands.ts`
- Remove: `extensions/oh-my-omp/loop/promise-detector.ts`
- Create: `test/autonomy-extension.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] Test default-off registration and the `/autonomy` command lifecycle.
- [ ] Test adapters for native OMP goal completion, targeted test/smoke evidence, EvalFly enforcement, and SpecSafe closure backed by a private, activation-bound, crash-recoverable receipt.
- [ ] Test fail-closed behavior when a configured gate is unavailable, stale, malformed, project-forged, or replayed.
- [ ] Register hooks only after contract tests pass.
- [ ] Remove Ralph/ULW runtime imports, state files, commands, promise detection, and formatting/typecheck references.
- [ ] Keep unrelated `ultrawork` prompt commands unchanged unless they directly invoke the deleted loop runtime.
- [ ] Run `bun test test/autonomy-extension.test.ts`, then the full suite and typecheck.

### Task 4: Refinement proposal ledger

**Files:**
- Create: `extensions/oh-my-omp/refinement/ledger.ts`
- Create: `extensions/oh-my-omp/refinement/schema.ts`
- Create: `test/refinement-ledger.test.ts`

- [ ] Test append-only proposal history, author/source attribution, artifact hashes, and causal parent IDs.
- [ ] Test lifecycle: `proposed`, `validated`, `approved`, `active`, `rejected`, `rolled_back`, `quarantined`.
- [ ] Test that validation cannot approve, approval cannot activate stale content, and activation requires the expected base hash.
- [ ] Test conflicting active proposals, rollback restoration, crash-safe replay, and corrupted-entry quarantine.
- [ ] Implement per-artifact leases and optimistic version checks; never mutate the user artifact from ledger replay alone.
- [ ] Record validation evidence as immutable references to exact run/report IDs.
- [ ] Run `bun test test/refinement-ledger.test.ts` and `bun run typecheck`.

### Task 5: Python-backed skill contract

**Files:**
- Create: `extensions/oh-my-omp/python-skills/manifest.ts`
- Create: `extensions/oh-my-omp/python-skills/environment.ts`
- Create: `extensions/oh-my-omp/python-skills/runner.ts`
- Create: `extensions/oh-my-omp/python-skills/process-tree.ts`
- Create: `test/python-skills.test.ts`

- [ ] Define and test manifest fields: Python requirement, locked dependencies, entrypoint, timeout, environment allowlist, network policy, input/output schemas, and maximum output bytes.
- [ ] Reject unpinned dependencies, path traversal, undeclared environment access, unsupported protocols, and duplicate skill IDs.
- [ ] Build content-addressed environments in private per-user XDG state, guarded by exclusive creation locks.
- [ ] Serialize and validate input before provisioning; invoke the entrypoint with JSON on stdin and require one bounded JSON response on stdout; keep stderr as diagnostics.
- [ ] Test success, schema rejection, timeout/process-tree termination, oversized output, nonzero exit, cache isolation, and cache reuse with a fixture skill.
- [ ] Run `bun test test/python-skills.test.ts` and `bun run typecheck`.

### Task 6: Persistent worker and command journal

**Files:**
- Create: `extensions/oh-my-omp/autonomy/agentd.ts`
- Create: `extensions/oh-my-omp/autonomy/journal.ts`
- Create: `extensions/oh-my-omp/autonomy/worker.ts`
- Create: `test/autonomy-agentd.test.ts`

- [ ] Test command IDs, claim leases, acknowledgements, duplicate delivery, expired-worker takeover, and single-writer fencing tokens.
- [ ] Test that a command is journaled before execution and acknowledged only after state persistence.
- [ ] Resume OMP sessions through the public file-backed SDK; do not read or patch OMP internal session files directly.
- [ ] Launch the worker through the existing OMP launch broker with readiness and bounded restart policy.
- [ ] Expose status through `/autonomy status`; do not create a second process supervisor.
- [ ] Test clean shutdown and orphan child cleanup.
- [ ] Run `bun test test/autonomy-agentd.test.ts` and a real start/status/stop smoke scenario in a temporary project.

### Task 7: Persisted scheduler and recovery

**Files:**
- Create: `extensions/oh-my-omp/autonomy/scheduler.ts`
- Create: `test/autonomy-scheduler.test.ts`

- [ ] Use an injected clock; test deadline ordering, restart recovery, missed deadlines, wall-clock jumps, and deterministic jitter.
- [ ] Claim a due schedule before delivery; coalesce equivalent wakeups while preserving distinct commands.
- [ ] Persist retry count, next deadline, last error, and owning fencing token.
- [ ] Bound retries and transition exhausted work to `failed` with evidence rather than looping forever.
- [ ] Compact journals only after writing and verifying a replacement snapshot; retain the prior generation until activation succeeds.
- [ ] Run `bun test test/autonomy-scheduler.test.ts` and `bun run typecheck`.

### Task 8: Safe kernel checkpoints

**Files:**
- Create: `extensions/oh-my-omp/autonomy/checkpoints.ts`
- Create: `test/autonomy-checkpoints.test.ts`
- Upstream when required: OMP kernel public checkpoint export/import API and its tests

- [ ] Probe the OMP 17 public extension/SDK API and record supported checkpoint capabilities.
- [ ] Test serialization of JSON-compatible variables, metadata, schema version, size limit, and source-kernel identity.
- [ ] Reject functions, handles, cyclic values, executable byte streams, foreign-kernel checkpoints, and unsupported schema versions.
- [ ] Restore into a fresh kernel before replacing the active kernel; failed restore must leave the current runtime untouched.
- [ ] If OMP lacks the required public API, open a narrow upstream OMP PR; Pantheon must expose `unsupported`, not a fake checkpoint fallback.
- [ ] Run targeted OMP upstream tests, Pantheon adapter tests, and a restart/restore smoke scenario.

### Task 9: Retained eval subagents

**Files:**
- Create: `extensions/oh-my-omp/autonomy/retained-agents.ts`
- Create: `test/retained-agents.test.ts`
- Upstream when required: OMP `eval.agent` keep-alive option and lifecycle tests

- [ ] Test default disposal remains unchanged.
- [ ] Test explicit retention returns an addressable handle, bounded TTL, owner session, and cleanup state.
- [ ] Test message delivery, concurrent retained agents, owner shutdown, TTL expiry, and process exit cleanup.
- [ ] If OMP lacks the public capability, open a narrow upstream OMP PR; Pantheon must report `unsupported` until that version is available.
- [ ] Run targeted OMP upstream tests and Pantheon capability tests.

### Task 10: Integration documentation and migration

**Files:**
- Modify: `README.md`
- Modify: `docs/harness-overview.md`
- Modify: `ATTRIBUTION.md`
- Modify: `UPDATE-LOG.md`
- Create: `docs/autonomy.md`

- [ ] Document opt-in setup, commands, private autonomy/receipt/Python state paths, project-local refinement state, gate semantics, worker lifecycle, refinement approvals, Python skill policy, and recovery.
- [ ] Document Ralph/ULW runtime removal and the `/autonomy` replacement path.
- [ ] Attribute Prime Agent ideas precisely; distinguish adapted concepts from copied code.
- [ ] Document unsupported checkpoint/retained-agent capabilities until the minimum upstream OMP version ships them.
- [ ] Add update-log entries for install/update behavior and verify all referenced paths and commands.

### Task 11: End-to-end verification and release evidence

**Files:**
- Modify: tests/evals only when a new observable contract requires coverage.
- Update: PR body with exact evidence.

- [ ] Run targeted tests for every new unit.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run format:check` and `bun run lint`.
- [ ] Run an isolated smoke flow: start goal, persist attempt, restart worker, resume session, fail one gate, pass it on retry, complete, and inspect the journal.
- [ ] Run a refinement flow: propose, validate, approve, activate, conflict, rollback, and verify restored hash.
- [ ] Run a Python fixture skill twice and verify environment reuse plus bounded cleanup.
- [ ] Run the relevant EvalFly suite and preserve its report ID.
- [ ] Request final engineering review; resolve every blocking finding with another tested slice.
- [ ] Push the final clean branch and update the draft PR with commands, results, migration notes, known upstream dependencies, and rollback instructions.
