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
- Made `/autonomy pause` an execution fence: it stops the run-scoped worker,
  rejects verification while paused, and resumes queued work only after
  `/autonomy resume`.
- Added approval-gated refinement and isolated Python skill contracts.
- Added capability adapters for JSON-only kernel checkpoints and retained
  subagents. Both report unsupported on stock OMP 17.2.14 because the required
  public APIs do not exist yet.
- Updated the root and extension dependency contract to
  `@oh-my-pi/pi-coding-agent ^17.2.14`.
- Existing `/ultrawork` and `/ulw` prompt commands remain installable
  orchestration prompts; they no longer own persistence or completion.

Autonomy objective state, executable queues, crash-recoverable SpecSafe gate
receipts, and Python caches live in private per-user XDG state. Refinement
history remains project-local under `.pi/refinement/`. See
[`docs/autonomy.md`](./docs/autonomy.md) for setup, migration, recovery, and
policy details.

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
