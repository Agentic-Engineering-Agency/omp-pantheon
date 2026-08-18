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
- opt-in verified autonomy with native OMP goal gates, durable session work,
  persisted deadlines, lease/fencing recovery, and bounded retries;
- approval-gated refinement plus isolated, manifest-driven Python skills;
- installation as one source-of-truth OMP bundle under `~/.omp/omp-pantheon`.

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
| Local enforcement | Block local session completion when explicit EvalFly evidence is required and missing. | Implemented; activated per project with `evalfly enforce start`. |
| CI enforcement | Reject PRs without EvalFly check evidence. | Template exists; consuming repos must install workflow and branch protection. |
| Branch E2E | Verify real user behavior through UI/backend/log/network evidence and negative cases. | Implemented as `agentic-branch-e2e` skill/protocol; not yet automatically imported into EvalFly. |
| Verified autonomy | Keep an objective running across agent/process boundaries without trusting completion prose. | Implemented as opt-in `/autonomy`, core native-goal and targeted-command gates, conditional exact EvalFly/SpecSafe adapters, durable journals, scheduler generations, and broker-managed `pantheon-agentd`. |
| Refinement | Validate and approve proposed harness changes before activation. | Agents can prepare a session-scoped JSON preview from natural language, but only interactive `aprobar` activates the exact reviewed candidate; the append-only ledger retains conflict, quarantine, and rollback states. |
| Python skills | Run skill-local Python with reproducible dependencies and explicit bounds. | Implemented with exact pins, content-addressed virtual environments, JSON contracts, and fail-closed network denial. |

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
   Optional `/autonomy` mode keeps the objective alive across session worker
   restarts and requires current core gates plus any EvalFly/SpecSafe contract captured at start.

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

## Verified autonomy status

Pantheon now provides an opt-in durable autonomy runtime. It journals objective
state and queued work, resumes persisted OMP sessions through the public SDK,
uses lease claims and fencing tokens for crash recovery, schedules absolute
deadlines with bounded deterministic retries, and compacts scheduler state only
through verified generations.

Completion requires native OMP goal completion and concrete verification
evidence for the same attempt and artifact revision. Model prose and legacy
Ralph/ULW promise markers are ignored.

Stock OMP 17.2.14 does not expose public eval-kernel export/import or retained
subagent keep-alive APIs. The corresponding Pantheon adapters therefore report
unsupported until upstream provides those contracts. See
[Verified autonomy](./autonomy.md) for commands, state paths, lifecycle,
recovery, refinement, and Python skill policy.

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
agents + verified autonomy + SpecSafe + Honcho memory + EvalFly
evidence/enforcement + trace hygiene and branch E2E protocol.

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
