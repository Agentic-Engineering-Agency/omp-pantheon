# Update log — track upstream oh-my-openagent (OMO)

This branch refreshes the ported pieces against the current upstream
[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (`dev`) and
adds the roadmap iter-2/3/4 pieces, all re-adapted to OMP's tool grammar.

## Scope

**Refresh (bring existing pieces to upstream's current content):**
- Agents: `sisyphus`, `hephaestus`, `oracle`, `atlas`
- Slash commands: `ultrawork`/`ulw`, `init-deep`, `refactor`, `handoff`, `start-work`, `remove-ai-slops`, `omomomo`
- Skills: `git-master`, `frontend-ui-ux`, `dev-browser`, `playwright`, `playwright-cli`, `ai-slop-remover`, `review-work`
- Loop: Ralph/ULW runtime review

**Expand (targeted, per the port's own roadmap):**
- Agents: `prometheus` (interview planner), `metis` (plan critic)
- Hooks: `todo-enforcer`, `comment-checker`, `intent-gate`
- Skills: `hyperplan`, `security-research`, `tech-debt-audit`, `remove-deadcode`

## 2026-08-11 — Prime Agent concepts adapted to OMP

- Added opt-in `/autonomy` and `autonomy_gate`; removed the extension's
  Ralph/ULW promise-loop runtime and its project-local loop state.
- Added a public-SDK session worker supervised by OMP's launch broker. It starts
  per project on demand; installation does not add or enable a global service.
- Added checksummed objective and command journals, lease/fencing recovery,
  persisted deadlines, deterministic bounded retries, and verified
  generation-based scheduler compaction.
- Made externally initiated `/autonomy pause` and `/autonomy cancel`
  execution fences: they persist only after the run-scoped worker reports
  terminal `exited`/`failed` (or adapter `stopped`). Stop errors and unsettled
  states leave the run active and are reported to the caller. Verification is
  rejected while paused; paused mutations still advance the artifact revision
  and invalidate every gate without resuming execution.
- Added a crash-consistent resident terminal handshake. The resident records a
  command-bound terminal intent, flushes the session, publishes its persistence
  receipt, and acknowledges the command before finalizing the objective. Only
  the journal finalizer/failure path may clear pending terminal intent; external
  pause/cancel/success/failure paths stop the worker, reload authoritative
  state, verify the original run still owns the transition, and reconcile any
  command created during the stop before applying an ID-scoped transition.
  Other terminal paths cannot bypass it. Missing, queued, failed, uncertain, or
  orphaned claimed commands fail the objective instead of being replayed.
  Resident run/command identity is shared across OMP's cache-busted module
  identities. The old worker exits before another claim on terminal state,
  missing state, or run ownership loss. External runtimes reload final state
  across process boundaries.
- Bound each persisted objective to its canonical OMP owner session and reject
  `/autonomy start` under `--no-session` before state or worker creation.
  Positive goal/verification evidence and `agent_end` attempt/continuation
  decisions use the emitting event context, so a same-runtime session switch
  cannot transfer ownership. Mutating tool results remain project-wide
  invalidation signals and reset gates from any session. Delayed evidence and
  terminal transitions also carry the captured run ID, so replacement runs
  reject stale receipts.
- Canonicalized project identity through the filesystem before deriving private
  state roots, ownership checks, daemon arguments, and journal bounds. Runtime
  attachment now prepares a complete project context before atomically
  publishing it, so concurrent project/session switches cannot mix controllers,
  stores, workers, or owner sessions.
- Classified every failure after headless prompt dispatch as an uncertain
  command outcome. Such commands are permanently fenced instead of released
  for retry, preventing duplicate tool side effects after idle, flush, disposal,
  heartbeat, receipt, or acknowledgement failures.
- Added human-only `/refinement` and `/python-skill` integration surfaces for
  approval-gated refinement and isolated Python skills. Rollback bytes stay in
  private per-user state; project state contains only checksummed history.
- Hardened final Prime host boundaries: concurrent gate receipts merge under
  lock; verification-command mutations invalidate older evidence; completed
  headless sessions are released; Python skill ancestors cannot be symlinked;
  and provisioning uses isolated startup with bounded output and process-tree
  termination.
- Added capability adapters for JSON-only kernel checkpoints and retained
  subagents. Both report unsupported on stock OMP 17.2.14 because the required
  public APIs do not exist yet.
- Updated the root and extension dependency contract to
  `@oh-my-pi/pi-coding-agent ^17.2.14`.
- Existing `/ultrawork` and `/ulw` prompt commands remain installable
  orchestration prompts; they no longer own persistence or completion.

Autonomy objective state, executable queues, crash-recoverable SpecSafe gate
receipts, refinement rollback snapshots, and Python caches live in private
per-user XDG state. Refinement history remains project-local under
`.pi/refinement/`. See [`docs/autonomy.md`](./docs/autonomy.md) for setup,
migration, recovery, and policy details.

## Upstream source map (`packages/omo-opencode/src/`)

| Piece | Upstream source |
|---|---|
| sisyphus | `agents/sisyphus/default.ts` (+ model overlays) |
| hephaestus | `agents/hephaestus/` |
| oracle | `agents/oracle.ts` |
| atlas | `agents/atlas/` |
| prometheus | `agents/prometheus/` |
| metis | `agents/metis.ts` |
| commands | `features/builtin-commands/templates/*.ts` |
| skills | `features/builtin-skills/*` and `.agents/skills/*` |
| todo-enforcer | `hooks/todo-continuation-enforcer/` |
| comment-checker | `hooks/comment-checker/` |
| intent-gate | realized in agent prompts upstream; ported here as a `before_agent_start` hook |

Each commit below covers one domain.
