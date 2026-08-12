# Attribution

`omp-pantheon` is a personal-config-tree port for [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi).
It is **not** a redistribution of any upstream harness; it adapts prompt content
and concepts to OMP's native tool grammar.

## Sources

- **Engine:** [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) — MIT. The
  underlying coding agent. This repo only ships config (agents/commands/skills/hooks)
  discovered by OMP; no OMP source is vendored.
- **Pantheon / OMO layer:** agents, skills, commands, loop, and hook concepts
  derived from [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent),
  licensed **SUL-1.0**. Original author: [@code-yeongyu](https://github.com/code-yeongyu).
  Content here is adapted (re-grammared) for OMP, not copied verbatim where the
  underlying tool surface differs.
- **Seshat / pi-seshat layer:** Ghola agents, SpecSafe discipline,
  Linear/GitHub/docs skills, lifecycle hooks, and the associated tests/port
  notes come from
  [pi-seshat](https://github.com/Agentic-Engineering-Agency/pi-seshat), the
  public Seshat the Ghola harness integrated into this OMP bundle. They are
  credited separately because they are not part of the OMO prompt lineage.
- **Prime Agent design inspiration:** long-running sessions, persistent goals
  and schedules, retained subagents, kernel checkpoints, Python-backed skills,
  and evidence-backed harness refinement were studied from
  [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent),
  licensed **MIT** (copyright Mario Zechner and Prime Intellect). Pantheon's
  implementation is original TypeScript written against OMP's public SDK and
  native goals, sessions, Task/Hub, eval, and launch broker. No Prime Agent
  source code, notebook tool surface, daemon implementation, or Pi package is
  copied or vendored. Unsupported OMP capabilities are exposed as unsupported
  rather than emulated through private internals.

## Grammar mapping (OMO → OMP)

| OMO | OMP |
|---|---|
| `task(subagent_type=…, prompt=…)` | `task(agent: "…", tasks: [{ id, description, assignment }])` |
| `category="…", load_skills=[…]` | `agent: "task"` with skills loaded in the assignment |
| `call_omo_agent` | `task` |
| `lsp_diagnostics` / `LspGotoDefinition` / `LspFindReferences` / `lsp_rename` | `lsp(action: "diagnostics" / "definition" / "references" / "rename")` |
| `ast_grep_search` / `ast_grep_replace` | `ast_grep` / `ast_edit` |
| Team Mode (`team_*`) | parallel `task` subagent batches |

## Licensing note

Because OMO-derived content is SUL-1.0, this tree inherits SUL-1.0 obligations
for that content. If this is ever published as an installable package (vs. a
personal config tree), licensing will be re-evaluated and explicit upstream
permission sought where required.
