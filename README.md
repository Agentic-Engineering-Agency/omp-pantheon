# omp-pantheon

**`omp-pantheon` is a local software-engineering harness for agentic coding.**
It is built on top of [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi),
but it is not just a set of prompts: it turns OMP into a disciplined workflow
for taking an issue from intent → spec → evals/tests → implementation → review
→ evidence → optional enforcement.

If you are arriving here from GitHub with no prior context:

- **OMP original is the runtime engine.** It gives agents tools, providers,
  subagents, LSP/DAP, file editing, browser/debug/shell access, and the native
  `explore`/`plan`/`task` workflow.
- **`omp-pantheon` is the engineering system around that engine.** It adds
  specialist agents, durable memory, SpecSafe/Seshat slice discipline, EvalFly
  evaluation evidence, local completion gates, trace hygiene, branch-level E2E
  verification, review protocols, and installable project templates.
- **Verified autonomy** with native OMP goal gates, durable command/schedule
  journals, a broker-managed resident worker, bounded retries, and recovery
  across process restarts.
- **The core differentiator:** most agent harnesses help an AI edit code; this
  harness tries to make agentic work *reviewable and enforceable* by tying it to
  contracts, evidence, reports, traces, and PASS/FAIL/INCONCLUSIVE verdicts.

In practical terms, this repo is for people who want a local, hackable agentic
engineering cockpit: one that can coordinate specialized agents, remember
project context, require eval evidence for load-bearing work, verify real user
flows, and make it harder for an agent to simply say “done” without proof.

Within the governed cross-product architecture, Pantheon has the narrower role
of **OMP Execution Adapter**: OMP is the Execution Harness, Ultimate Harness is
the sole Meta Harness / Run Control, Telar owns business intent, policy, stable
identity, authority, and the normalized ledger, and SpecSafe remains repo-local
assurance. See the [Telar integration boundary and future operating
plan](./docs/telar-integration.md).

## Prime Agent-inspired verified autonomy

Pantheon's autonomy layer adapts selected ideas from
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)—long-running
work, persistent goals, schedules, background continuity, continual harness
refinement, and executable skills—into OMP-native, evidence-gated contracts:

- `/autonomy` keeps durable objectives moving across process restarts with
  persisted schedules, bounded retries, and completion gates that require
  current command, EvalFly, or SpecSafe evidence rather than agent prose;
- the broker-managed `pantheon-agentd` worker resumes file-backed OMP sessions
  and uses leased, fenced command delivery to prevent stale workers from
  advancing a run;
- human-only `/refinement` and `/python-skill` flows keep reusable improvements
  approval-gated, attributable, reversible, and isolated.

This is an original TypeScript implementation against OMP's public SDK—not a
port or redistribution of Prime Agent. No Prime Agent source code is copied or
vendored. Prime Agent is MIT-licensed, copyright Mario Zechner and Prime
Intellect. See [ATTRIBUTION.md](./ATTRIBUTION.md) for the precise lineage and
[the autonomy guide](./docs/autonomy.md) for usage and current capability
limits.

## What this repo contains

`omp-pantheon` currently bundles:

- **OMP-compatible agents** for planning, architecture, implementation, tests,
  validation, review, stewardship, and documentation.
- **SpecSafe/Seshat workflow discipline** so work is tied to explicit slices,
  source issues, acceptance criteria, and reviewable evidence.
- **Honcho memory integration** for durable recall/search across sessions when
  configured.
- **EvalFly**, a project-local evaluation-evidence system with `evals/`,
  deterministic suites, run JSON, markdown reports, trace import/normalization,
  privacy audits, comparisons, summaries, and explicit local enforcement.
- **Local enforcement hooks** that can block OMP session completion when a
  project has opted into EvalFly enforcement and matching passing evidence is
  missing.
- **Agentic branch E2E verification** for testing a feature branch as a real
  user with frozen criteria, UI/network/log/backend evidence, negative cases,
  and PASS/FAIL/INCONCLUSIVE verdicts.
- **Guardrails and lifecycle hooks** for todos, approvals, intent checks,
  comments, SpecSafe sessions/subagents, fallback audits, and artifact hygiene.
- **Approval-gated refinement and isolated Python skills** exposed through
  human slash commands, with checksummed ledgers, private rollback snapshots,
  content-addressed environments, strict JSON contracts, resource bounds, and
  fail-closed network policy.
- **Dogfooding:** this repo contains its own root `evals/` smoke suite that
  protects critical harness files and proves EvalFly works on the harness itself.

## How this differs from other agent systems

This is not trying to be a SaaS observability product, cloud IDE, or benchmark
runner. Existing systems cover parts of the problem well:

- Claude Code, Codex, and OMP provide strong agent runtimes.
- OpenHands and HumanLayer focus on agent/session orchestration and software
  factory workflows.
- Braintrust and LangSmith focus on traces, evals, datasets, dashboards, and
  production observability.
- Inspect AI and OpenAI Evals focus on formal eval frameworks.
- SWE-agent focuses on issue-solving and SWE-bench-style agent evaluation.

`omp-pantheon` is different because it combines the local pieces into one OMP
bundle: runtime + specialist agents + SpecSafe + Honcho memory + EvalFly
evidence/enforcement + trace hygiene + branch E2E protocol. It is less mature
than those products in UI, cloud orchestration, visual observability, managed
datasets, and full CI/branch-protection automation; its advantage is that it is
local, inspectable, hackable, and shaped around an eval-first engineering loop.

> This is a **personal-config-tree port**, not a redistribution of any upstream
> harness. Prompt content and concepts derived from
> [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent)
> (SUL-1.0) are adapted to OMP's tool grammar. The Seshat/Ghola, SpecSafe,
> Linear/GitHub/docs, and discipline-hook layer is credited to
> [pi-seshat](https://github.com/Agentic-Engineering-Agency/pi-seshat), the
> public Seshat the Ghola harness integrated into this bundle. See
> [ATTRIBUTION.md](./ATTRIBUTION.md).

## What makes it different from original OMP

| Area | Original OMP | `omp-pantheon` |
|---|---|---|
| Runtime | General-purpose agent harness with tools, providers, subagents, LSP/DAP, and browser/debug adapters. | Keeps the OMP runtime, then installs a project-specific engineering discipline layer. |
| Agents | Native general agents such as `explore`, `plan`, `task`, `reviewer`, `designer`, and `librarian`. | Adds Pantheon and Seshat agents for strategy, specs, tests, implementation, validation, review, documentation, and stewardship. |
| Work contract | Depends on the prompt and project instructions. | Adds SpecSafe/Seshat slice discipline so work can be tied to a source issue, acceptance criteria, and reviewable evidence. |
| Memory | OMP session/history plus configured tools. | Adds Honcho durable memory tools for recall/search/conclusions across sessions when available. |
| Evaluations | No built-in project-local eval evidence contract. | Adds EvalFly: `evals/`, deterministic suites, run JSON, markdown reports, trace import/normalization/audit, compare/report/summary commands, and templates. |
| Enforcement | Normal harness/tool completion behavior. | Adds explicit local EvalFly enforcement: `evalfly enforce start` writes project-local state and the OMP stop gate blocks completion without fresh matching passing evidence. |
| Branch QA | Whatever the user asks the agent to test. | Adds `agentic-branch-e2e`: freeze criteria first, run real user flows, capture UI/network/log/backend evidence, drive negative cases, and emit PASS/FAIL/INCONCLUSIVE. |
| Verified autonomy | No Pantheon-specific durable objective runtime. | Adds opt-in `/autonomy`, native-goal and targeted-command gates, conditional exact EvalFly/SpecSafe adapters, broker-managed session resumption, leased/fenced command delivery, persisted scheduling, and bounded retries. |
| Refinement/Python skills | General extension and tool mechanisms. | Adds human-only `/refinement` and `/python-skill` commands for approval-gated append-only refinement plus manifest-driven isolated Python execution with exact pins and content-addressed environments. |
| Safety boundary | OMP permissions and configured hooks. | Adds intent gates, approval gates, comment checks, SpecSafe hooks, EvalFly artifact hardening, privacy checks for sanitized traces, and non-global opt-in enforcement. |
| Dogfooding | Not applicable. | The repo contains its own `evals/` smoke suite protecting critical harness files and tests that keep the suite synchronized. |

## Current capability snapshot

Implemented and verified in this bundle:

- integrated Pantheon + Seshat/Ghola agent roster;
- SpecSafe, Linear/GitHub/docs, latest-docs, review, and verification skills;
- Honcho memory tool integration in the OMP extension layer;
- OMP slash commands including `/omomomo`, `/handoff`, `/start-work`,
  `/refactor`, `/remove-ai-slops`, and `/evalfly-enforce`;
- lifecycle hooks and guardrails for todo discipline, intent, comments,
  approvals, SpecSafe sessions/subagents, and fallback audits;
- EvalFly CLI commands: `validate`, `run`, `check`, `latest`, `list`,
  `summary`, `traces`, `audit-traces`, `compare`, `report`, `curate-trace`,
  `normalize-trace`, `import-session-trace`, and `enforce status/start/stop/explain`;
- local EvalFly enforced mode with project-local state under
  `.pi/evalfly/enforcement.json`;
- an OMP `session_stop` gate that requires matching fresh passing EvalFly
  evidence when enforced mode is active;
- metadata-only EvalFly trace buffering while enforcement is enabled;
- hardened run/report/trace artifact writes against path escape and symlink
  surprises;
- optional GitHub Actions templates for advisory and required EvalFly checks;
- bootstrap support for initializing project-local `evals/` with
  `--with-evalfly`;
- root `evals/` dogfood suite in this repository with critical smoke cases;
- tests covering EvalFly state, command parsing, stop-gate behavior, trace
  buffering, CLI behavior, and the dogfood eval repo;
- `agentic-branch-e2e` as the real-user branch verification protocol.
- opt-in `/autonomy` commands and the `autonomy_gate` tool;
- durable autonomy state, command queue, persisted scheduler generations,
  lease/fencing recovery, and broker-managed `pantheon-agentd`;
- human-only `/refinement` lifecycle with append-only, checksummed approval
  history and private rollback snapshots;
- human-only `/python-skill` discovery/execution for manifest-validated isolated
  Python skills with environment reuse;
- capability-gated checkpoint and retained-agent contracts that fail honestly
  when stock OMP 17.2.14 lacks the required public APIs.

## What it does not claim yet

This repository is a strong opt-in evidence stack, not a fully closed global
evaluation platform. Today it does **not** automatically:

- protect every downstream repository;
- install GitHub branch protection or rulesets;
- capture every OMP trace persistently without an explicit project flow;
- execute LLM/human judges as required EvalFly runtime checks;
- evaluate full agentic workflows end-to-end inside the EvalFly runner;
- convert every branch-E2E run record into EvalFly evidence;
- promote traces into eval cases automatically;
- maintain hidden/dev eval splits;
- prune or deduplicate stale eval debt.
- provide public OMP 17.2.14 kernel export/import or retained-agent keep-alive
  capabilities; Pantheon reports both as unsupported instead of using internals.

Those are explicit roadmap items, not completed claims.

## Typical issue flow

A fully loaded `omp-pantheon` session should handle a non-trivial issue like
this:

```text
issue
→ SpecSafe/Seshat slice and acceptance criteria
→ eval/test plan before implementation
→ EvalFly suite/check setup
→ optional evalfly enforce start --suite <suite> --commit-range <base>..<head>
→ implementation by specialist agents
→ unit/type/lint verification
→ EvalFly run JSON + canonical markdown report
→ sanitized trace import/normalization/audit when relevant
→ agentic-branch-e2e for UI or real user behavior
→ validator/reviewer verdicts against the original issue
→ local stop gate passes only if enforced evidence exists
```

Prompt an agent with:

```text
Resolve this issue using the full omp-pantheon flow: SpecSafe slice,
eval-first criteria, EvalFly local enforcement when appropriate, tests/evals
before implementation, implementation, EvalFly check/report, agentic-branch-e2e
if behavior is user-visible, validator/reviewer pass, artifact cleanup, and a
final evidence report. Do not close if required evidence is missing.
```

## Layout

```text
agents/                 OMP agent definitions (*.md)
commands/               OMP slash commands (*.md)
skills/<name>/SKILL.md  OMP skills and workflow protocols
skills/evalfly/          EvalFly templates, CLI, and adoption docs
evals/                  This repo's dogfood EvalFly smoke suite
hooks/*.ts              OMP lifecycle hooks from Seshat/SpecSafe
extensions/oh-my-omp/   verified autonomy, EvalFly, Honcho, lifecycle hooks
test/                   integration/regression tests for the bundle
docs/                   public overview, EvalFly guides, plans, port notes
package.json            root test/typecheck/format/lint runner
install.sh              symlink/copy this bundle into ~/.omp/agent/
```

The directory tree mirrors `~/.omp/agent/`, so installation is just placing these
files where OMP's native discovery looks for them.

## Install

```bash
git clone https://github.com/Sebastiangmz/omp-pantheon
cd omp-pantheon
./install.sh            # symlinks the bundle into ~/.omp/agent/ (re-runnable)
```

Then start `omp`; the agents, commands, skills, hooks, EvalFly tooling, and OMP
extension are live. Enforced EvalFly mode remains project-local and must be
explicitly activated per repo/session.

## More docs

- [Harness overview](./docs/harness-overview.md) — complete newcomer-oriented
  description of the architecture, differentiators, issue flow, and roadmap.
- [Telar integration boundary](./docs/telar-integration.md) — Pantheon's OMP
  Execution Adapter seam, ownership limits, deletion tests, and future plan.
- [Verified autonomy](./docs/autonomy.md) — setup, commands, gates, worker and
  scheduler recovery, state paths, refinement, Python skills, and capability
  boundaries.
- [EvalFly overview](./docs/evalfly/README.md) — current EvalFly modes, status,
  and boundaries.
- [EvalFly modes](./docs/evalfly/modes.md) — normal, advisory, manual, local
  enforced, and CI-enforced modes.
- [EvalFly artifacts and traces](./docs/evalfly/artifacts-and-traces.md) — run,
  report, raw trace, sanitized trace, and audit boundaries.
- [EvalFly enforcement roadmap](./docs/evalfly/enforcement-roadmap.md) — what
  local enforcement does now and what remains.

## Status

`omp-pantheon` is actively updated and dogfooded. The current honest status is:
**local integrated harness with strong opt-in evidence/enforcement**, not yet a
complete always-on 38/40 closed-loop evaluation platform. See the docs above for
the implemented layers and the remaining roadmap.
