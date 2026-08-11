# oh-my-omp

Integrated OMP extension for Sebastián's `omp-pantheon` bundle. It started as an
[oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent) port
onto [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi), and now also wires
the Seshat/SpecSafe runtime into the local harness.

## What's in this bundle

### Extension (`./index.ts`)
- Advertises `~/.omp/agent/skills/` via `resources_discover`.
- Owns the opt-in **verified autonomy runtime**: exact native OMP goal
  ownership, a fixed host-run verification command, bounded attempts,
  checksummed/CAS private state, and a run-scoped broker worker.
- Stores objective state, executable worker commands, and schedules outside
  the repository in a private per-user state directory; incomplete attempts
  enqueue durable continuations, leases heartbeat, and terminal
  `failed`/`uncertain` outcomes are not replayed indefinitely.
- Registers `/autonomy` and the parameterless `autonomy_gate` verification
  tool. See [`docs/autonomy.md`](../../docs/autonomy.md) for lifecycle, state,
  security boundaries, and migration details.
- Registers lifecycle guardrails: `todo-enforcer`, `comment-checker`, and
  `intent-gate`.

### Markdown slash commands (`~/.omp/agent/commands/`)
- `/ulw`, `/ultrawork` — ULTRAWORK-mode prompt expansion.
- `/init-deep` — hierarchical AGENTS.md generator.
- `/refactor` — codemap-driven, plan-agent-backed refactor workflow.
- `/handoff` — context-summary builder for new sessions.
- `/start-work` — Sisyphus session entry, hands off to `atlas`.
- `/remove-ai-slops` — parallel branch-wide slop removal.
- `/omomomo` — integrated bundle easter egg.

### Agents (`~/.omp/agent/agents/`)
- Pantheon: `sisyphus`, `hephaestus`, `oracle`, `atlas`, `prometheus`, `metis`.
- Seshat: `steward`, `spec-writer`, `implementer`, `test-writer`, `validator`,
  `reviewer`, `reviewer-kimi`, `doc-scout`.

### Skills (`~/.omp/agent/skills/`)
- Pantheon: `ai-slop-remover`, `dev-browser`, `frontend-ui-ux`, `git-master`,
  `hyperplan`, `playwright`, `playwright-cli`, `remove-deadcode`,
  `review-work`, `security-research`, `tech-debt-audit`.
- Seshat/SpecSafe: `bootstrap`, `coherence`, `docs`, `env-doctor`,
  `evaluation-flywheel`, `github`, `latest-docs`, `linear`, `push`, `specsafe`.
- EvalFly: opt-in templates and CLI under `skills/evalfly/` for deterministic
  validation/run/report/trace-curation evidence; the bundled `evalfly-advisor`
  hook is inactive unless a project has both `.pi/evalfly/hints-enabled` and
  `evals/config.json`, and it only adds non-blocking reminder context.

### Hooks
- Extension hooks: `todo-enforcer`, opt-in `evalfly-advisor`, `comment-checker`,
  `intent-gate`.
- Agent hooks: `specsafe-session`, `specsafe-subagents`, `i-approve`,
  `fallback-audit`.

## Source attribution

Original OMO prompt content and concept:
[code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)
(SUL-1.0).

Seshat/Ghola agents, SpecSafe hooks/skills, and Linear/GitHub/docs skills come
from [pi-seshat](https://github.com/Agentic-Engineering-Agency/pi-seshat), the
public Seshat the Ghola harness integrated into this bundle.

This is a personal-config-tree port, not a redistribution. If this is ever
published as an installable package, licensing will be re-evaluated then.

The OMO templates were adapted to OMP's tool grammar:

| OMO | OMP |
|---|---|
| `task(subagent_type=…, prompt=…)` | `task(agent: "…", tasks: [{ id, description, assignment }])` |
| `category="…", load_skills=[…]` | `agent: "task"` (with appropriate skill loads in the assignment) |
| `call_omo_agent` | `task` |
| `lsp_diagnostics` | `lsp(action: "diagnostics")` |
| `LspGotoDefinition` | `lsp(action: "definition")` |
| `LspFindReferences` | `lsp(action: "references")` |
| `lsp_rename` | `lsp(action: "rename")` |
| `ast_grep_search` / `ast_grep_replace` | `ast_grep` / `ast_edit` |
| `background_output` / `background_cancel` | OMP's `task`/Hub lifecycle plus the verified `/autonomy` runtime provide bounded continuation and durable recovery. |

## How it loads

OMP discovers extensions in `~/.omp/agent/extensions/<name>/` automatically. The `package.json` `omp.extensions` field points the loader at `index.ts`. No manual registration needed.

Slash command markdown is discovered from `~/.omp/agent/commands/`.
Agent markdown is discovered from `~/.omp/agent/agents/`.
Skill `SKILL.md` files are discovered from `~/.omp/agent/skills/<name>/`.
