# omp-pantheon Agent Rules

This repository supplies the OMP agents, skills, evaluations, guardrails, extensions, and workflow integrations used by local agentic-engineering projects.


## Stack

- Language / runtime: TypeScript ES modules on Bun, plus shell installation scripts.
- Framework / platform: Oh My Pi discovery tree, EvalFly, SpecSafe/Seshat hooks, and Linear SDK integration.
- Package manager: Bun (`bun.lock`).

## Non-negotiables

- Preserve the discovery contracts under `agents/`, `commands/`, `skills/`, `hooks/`, and `extensions/oh-my-omp/`; `install.sh` exposes these assets under `~/.omp/agent/` for downstream projects.
- Treat agent definitions and `skills/<name>/SKILL.md` files as consumed interfaces. Keep names, frontmatter, tool grammar, handoffs, and referenced paths synchronized with their tests and callers.
- Keep EvalFly evidence and enforcement fail-closed. Do not weaken freshness, matching-evidence, path-containment, symlink, trace-privacy, or explicit opt-in boundaries.
- Linear reads may run directly, but mutations must retain the `--i-approve` preview gate and the private `.pi/.linear-log.jsonl` audit record.
- Never commit credentials, raw sensitive traces, or project-local enforcement state.

## Commands

| Purpose | Command |
|---|---|
| Install dependencies | `bun install` |
| Install the bundle | `./install.sh` |
| Test | `bun test` |
| Unit tests | `bun run test:unit` |
| Typecheck | `bun run typecheck` |
| Format check | `bun run format:check` |
| Lint | `bun run lint` |

## Verification gates

- Required for agent, skill, hook, extension, or CLI changes: `bun test` and `bun run typecheck`.
- Required for release: `bun test`, `bun run typecheck`, `bun run format:check`, and `bun run lint`.
- EvalFly changes must also produce the matching suite/check evidence described by the affected EvalFly contract; test success alone does not replace that evidence.
- Installation changes must be exercised through the installer or bootstrap path they modify, without overwriting an existing external OMP tree.

## Read order

1. `README.md`
2. `docs/harness-overview.md`
3. The affected definition under `agents/`, `commands/`, or `skills/`
4. The corresponding implementation under `hooks/` or `extensions/oh-my-omp/`
5. The contract tests under `test/` and, for evaluation work, `evals/config.json`

## Scope discipline

- Default to the smallest change that preserves every downstream agent and skill contract.
- Update all linked definitions, tests, templates, and installation paths together; never leave a second convention beside the existing one.
- Keep enforcement project-local and opt-in; do not turn this bundle into an implicit global policy layer.
- Treat upstream-derived material and attribution boundaries in `ATTRIBUTION.md` as part of the change surface.

## Deviations

- None.
