# omp-pantheon harness overview

`omp-pantheon` is a local agentic engineering harness built on top of OMP. It is
meant to make an agent session behave less like an unstructured chat and more
like a disciplined engineering pipeline: issue → contract → evals/tests →
implementation → evidence → review → enforcement.

It does not replace OMP. It uses OMP as the runtime and adds the work system
around it.

## The short version

Original OMP gives you the engine: providers, tools, subagents, file edits,
shell, browser, debugger, LSP/DAP, and general-purpose agent workflows.

`omp-pantheon` adds the production discipline around that engine:

- specialist agents for planning, specs, implementation, tests, validation, review, and stewardship;
- SpecSafe/Seshat conventions so work is tied to a traceable slice instead of a vague prompt;
- Honcho memory integration for durable recall and search when available;
- EvalFly for project-local eval configs, deterministic runs, reports, trace hygiene, compare/summary commands, and local enforcement;
- branch E2E protocol for testing user-visible changes through real app behavior;
- lifecycle hooks and guardrails that make unsafe or evidence-free completion harder;
- installation as one source-of-truth OMP bundle under `~/.omp/omp-pantheon`.

## Progressive skill routing

OMP still discovers every skill, resolves source precedence, and keeps the full
active `Skill[]` registry. It already defers each `SKILL.md` body until a
`skill://<name>` read; Pantheon additionally removes unselected catalog entries
from the execution turn. The catalog parser accepts both official OMP renderings:
the standard list form whose entries start with `- name: description` and may
carry unindented continuation text or blank separator lines, and the
custom-system-prompt `<skill name="name">...description...</skill>` XML form. It
only rewrites homogeneous, byte-preservable catalogs; mixed or malformed
catalogs fail open.

Before each execution turn, Pantheon's final `before_agent_start` handler sends
the user prompt and complete name/description catalog to the active model in a
separate, tool-free routing call. A strict response with
`confidence: "certain"` selects catalog names. Selections accumulate within one
session and render in original catalog order; switch, branch, and shutdown
events clear them.
This changes only the first system-prompt segment's `<skills>` block. Skill
discovery, manual `skill://` reads, commands, tools, project context, and all
other system-prompt bytes retain their existing behavior.

Routing is fail-open. Missing markers, model or credential resolution failures,
timeouts, provider errors, invalid JSON, unknown or duplicate names, and
`confidence: "uncertain"` all restore the exact original `systemPrompt` array.
Debug logs contain only the failure reason, catalog count, and selected count;
they never contain prompts, descriptions, credentials, or model responses. The
extension changes no global OMP configuration.

The 2026-08-19 active-discovery probe found 289 visible skills and an estimated
30,030 catalog tokens:

| Provider | Skills | Estimated catalog tokens |
|---|---:|---:|
| `claude-plugins` | 173 | 21,131 |
| `claude` | 23 | 3,004 |
| `omp-managed` | 51 | 2,958 |
| `custom` | 23 | 1,454 |
| `native` | 18 | 1,404 |
| `agents` | 1 | 79 |

Those are system-prompt estimates from rendered skill metadata, not provider
usage. Server-side prompt caching can make `usage.input` hide most of the
catalog delta; a controlled probe observed 19,501 input tokens normally and
19,387 with `--no-skills`, so provider usage alone is not accepted as catalog
evidence.

The active-model routing evaluation in
`evals/evidence/progressive-skill-routing-2026-08-19.json` covers six fixed
scenarios: one domain, multiple skills, mandatory process plus domain, no
domain match, ambiguity, and a task switch. Each scenario compares an
unmodified full-catalog baseline with a production-router candidate using
`openai-codex/gpt-5.6-sol`, temperature zero, the same request, and the complete
289-skill catalog. All five deterministic candidates matched the baseline skill
set exactly. The ambiguous candidate returned `confidence: "uncertain"` and
restored the exact original prompt.

An isolated execution probe rendered one skill before routing and zero after
routing, with the same non-skill SHA-256 digest
`3f5a173ddc99fe9d62364559dd1938a22ea59fb0bbf768257abaa3d9bcd93201`.
The execution model returned `OK` and reported 19,378 input tokens. This
subprocess evidence proves byte preservation and catalog removal for its
rendered profile; it does not claim a live 289-to-zero turn because that
profile exposed only one of the 289 skills found by the separate discovery
inventory.

For branch E2E compatibility probes, use an isolated neutral CWD whose local
`.omp/config.yml` does not narrow `skills.includeSkills`. A project-local CWD
that intentionally filters skills should be probed separately and must remain
filtered rather than being expanded by progressive routing.

Use a fixed prompt, model, CWD, and fresh ephemeral session for operational
comparisons:

```bash
prompt='Responde exactamente: OK'
model='openai-codex/gpt-5.6-sol'
cwd="$(pwd)"
omp --mode json --print --no-session --model "$model" --cwd "$cwd" "$prompt"
omp --mode json --print --no-session --model "$model" --cwd "$cwd" --no-skills "$prompt"
```

Capture the final `message_end` usage from both commands, but pair it with the
actual rendered catalog count/token estimate and a digest of the non-skill
prompt. `skill://diagnosing-omp-initial-context` defines the controlled probe
and attribution procedure.

## What this harness is optimizing for

The target failure mode is not “the agent cannot edit code.” OMP already solves that.

The target failure modes are:

- the agent implements before understanding the issue;
- acceptance criteria are implicit or move after the fact;
- tests are added after implementation only to justify the current behavior;
- the agent says “done” without durable evidence;
- traces contain raw private data or are not reproducible;
- review checks the diff but not the original contract;
- every repo invents its own way to decide whether agentic work is safe to merge.

`omp-pantheon` addresses those by making the expected path explicit and repeatable.

## Main layers

| Layer | Purpose | Current state |
|---|---|---|
| OMP runtime | Tool execution, providers, subagents, file edits, browser/debug/shell/LSP/DAP. | Provided by upstream OMP. |
| Pantheon agents | Strategy, orchestration, deep implementation, architecture consultation, planning. | Installed as OMP agents. |
| Seshat/Ghola agents | Product/spec/test/implementation/validation/review/doc roles. | Installed as OMP agents with EvalFly-aware contracts where relevant. |
| SpecSafe/Seshat discipline | Tie work to slices, specs, approvals, docs, issue/PR context, and guarded mutations. | Implemented as skills/hooks/agent conventions. |
| Honcho memory | Durable memory recall/search/conclusions across sessions. | Integrated through the OMP extension/tool layer when configured. |
| EvalFly | Project-local evaluation evidence: config, cases, runs, reports, traces, compare, enforcement. | Implemented as opt-in CLI, templates, docs, hooks, and tests. |
| Progressive skill routing | Keep every skill discoverable while exposing only certain, cumulative catalog selections to the execution turn. | Implemented in the Pantheon extension; all failures restore the original full prompt. |
| Local enforcement | Block local session completion when explicit EvalFly evidence is required and missing. | Implemented; activated per project with `evalfly enforce start`. |
| CI enforcement | Reject PRs without EvalFly check evidence. | Template exists; consuming repos must install workflow and branch protection. |
| Branch E2E | Verify real user behavior through UI/backend/log/network evidence and negative cases. | Implemented as `agentic-branch-e2e` skill/protocol; not yet automatically imported into EvalFly. |

## The intended issue flow

A non-trivial issue should move through these stages:

```text
1. Source of truth
   Issue, PRD, user request, or diff-inferred scope.

2. Contract
   SpecSafe/Seshat slice, acceptance criteria, explicit PASS/FAIL/INCONCLUSIVE rules.

3. Eval/test plan
   Define what evidence must exist before implementation is considered complete.

4. EvalFly setup
   Validate or create `evals/config.json`; add/update deterministic cases when possible.

5. Enforcement choice
   For load-bearing work, activate project-local enforcement for the suite and commit range.

6. Implementation
   Specialist agents implement without deleting, weakening, or relabeling required evals.

7. Evidence
   Run tests and EvalFly; produce run JSON and canonical markdown report.

8. Trace hygiene
   Import/normalize/audit sanitized traces when execution evidence matters.

9. Branch E2E
   For user-visible behavior, drive the real stack as a user, capture UI/network/log/backend evidence, and test negative cases.

10. Validation/review
    Validator and reviewer compare implementation and evidence against the original issue, not just against green tests.

11. Completion gate
    If enforcement is active, session stop is blocked until matching fresh passing EvalFly evidence exists.
```

## How to ask an agent to use the full harness

Use a prompt like this:

```text
Resolve this issue using the full omp-pantheon flow: create or use a SpecSafe/Seshat slice, freeze acceptance criteria, define eval/test evidence before implementation, initialize or update EvalFly if needed, activate local EvalFly enforcement when the work is load-bearing, implement without weakening required evals, run targeted tests and EvalFly check/report, use agentic-branch-e2e for real user-visible behavior, import/normalize/audit sanitized traces if relevant, run validator/reviewer, clean generated artifacts that should not be committed, and report final PASS/FAIL/INCONCLUSIVE evidence. Do not declare completion if required evidence is missing.
```

For stricter work:

```text
Strict mode: eval first, feature second. Do not implement until criteria/evals/tests are defined. Do not close until EvalFly enforcement passes. Mark any bypassed production layer as INCONCLUSIVE.
```

## EvalFly status

EvalFly currently provides:

- `evals/config.json` schema validation;
- deterministic suite execution;
- run records under `evals/runs/`;
- reports under `evals/reports/`;
- latest/list/summary/report commands;
- baseline-to-after compare;
- sanitized trace listing, curation, normalization, import, and audit;
- explicit local enforcement state in `.pi/evalfly/enforcement.json`;
- `session_stop` gate behavior when enforcement is active;
- advisory and required GitHub Actions templates;
- this repository's own root `evals/` dogfood suite.

EvalFly does not yet provide:

- automatic always-on trace capture for every OMP session;
- required LLM/human judge execution;
- semantic/agentic workflow runner beyond the current deterministic checks;
- automatic branch protection installation;
- automatic branch-E2E run-record import into EvalFly;
- trace-to-eval promotion workflow;
- hidden/dev split management;
- eval debt prune/dedupe tooling.

## Current dogfood suite

This repository contains a real root `evals/` tree. The smoke suite protects
critical harness files with deterministic `file_exists` checks, including:

- `README.md`;
- `commands/evalfly-enforce.md`;
- `skills/evalfly/bin/evalfly.ts`;
- `skills/evalfly/bin/enforcement-state.ts`;
- `extensions/oh-my-omp/evalfly/enforcement-gate.ts`;
- `extensions/oh-my-omp/evalfly/trace-buffer.ts`;
- `.github/workflows/verify.yml`;
- `docs/evalfly/modes.md`;
- `skills/evaluation-flywheel/SKILL.md`;
- `test/evalfly-enforcement-gate.test.ts`.

This dogfood suite is intentionally shallow today. It proves the repo has a real
project-local eval structure and protects critical harness files. It is not yet
a semantic proof that the full agentic workflow behaves correctly.

## Honest maturity position

The harness is currently best described as:

```text
A strong local OMP engineering harness with opt-in evidence and enforcement.
```

It should not yet be described as:

```text
A complete always-on closed-loop evaluation platform for every repo.
```

The differentiator is the integrated local composition: OMP runtime + specialist
agents + SpecSafe + Honcho memory + EvalFly evidence/enforcement + trace hygiene
and branch E2E protocol.

The remaining maturity work is to close the loop across CI/branch protection,
semantic/agentic eval execution, persistent trace capture, judge execution,
trace-to-eval promotion, and eval maintenance.

## Roadmap

The next highest-impact slices are:

1. Install required EvalFly CI plus GitHub branch protection/ruleset in a real pilot repository.
2. Add richer EvalFly assertions beyond `file_exists`.
3. Connect `agentic-branch-e2e` run records to EvalFly evidence artifacts.
4. Add automatic sanitized OMP trace capture with strict privacy boundaries.
5. Execute real LLM/human judges where configured.
6. Add trace-to-eval candidate promotion.
7. Add hidden/dev eval split support.
8. Add eval debt prune/dedupe tooling.
9. Strengthen SpecSafe linkage from slice → eval run → trace → report → commit/PR.
