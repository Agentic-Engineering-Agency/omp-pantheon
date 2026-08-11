# Verified autonomy

Pantheon autonomy is an explicit, project-local execution mode built on OMP's public SDK. It persists objective state, resumes queued OMP sessions through a broker-managed worker, and accepts completion only from current objective evidence.

It is opt-in. Normal OMP sessions are unchanged until `/autonomy start` is used.

## Requirements and setup

- Install this bundle so `extensions/oh-my-omp/index.ts` is discovered by OMP.
- Use `@oh-my-pi/pi-coding-agent` 17.2.14 or a compatible 17.x release.
- Start OMP in the target project. All autonomy state is written beneath that project's `.pi/` directory.

No global daemon is installed. Starting an autonomy run asks OMP's launch broker to run `pantheon-agentd` for that project with `restart: on-failure` and `persist: true`.

## Commands

```text
/autonomy start <task> [--max-attempts=N]
/autonomy status
/autonomy pause
/autonomy resume
/autonomy cancel
/autonomy explain
```

`start` creates a new run and starts the resident worker. A terminal run may be followed by another run; journal revisions remain contiguous. `pause` and `resume` change the run state. `cancel` is terminal and stops the worker. `status` reports the run, attempt, artifact revision, gates, and broker worker state.

## Completion contract

The default run has two gates:

1. `native-goal`: Pantheon records a pass only when OMP emits a native `goal_updated` event with status `complete`.
2. `verification`: the agent must call the `autonomy_gate` tool with concrete pass/fail evidence.

Every required gate must pass for the same attempt and artifact revision. An artifact change invalidates old evidence. A failed or missing gate causes another bounded attempt; exhausting `maxAttempts` records a terminal failure with evidence.

Model prose is never completion evidence. `<promise>DONE</promise>`, similar markers, and an `agent_end` event cannot complete a run by themselves.

## Worker lifecycle and recovery

`pantheon-agentd` uses only public OMP APIs:

- `SessionManager.open(sessionFile)` reopens persisted session state;
- `createAgentSession(...)` creates the headless session;
- the worker waits for idle, flushes the session manager, then records a persistence receipt before acknowledging work.

Commands are journaled before execution. Claims have leases and monotonically increasing fencing tokens. An interrupted worker releases the command; an expired claim can be taken over after restart. Re-enqueueing an identical command ID is idempotent, while a conflicting payload is rejected.

The scheduler stores absolute deadlines, claims due work before delivery, coalesces equivalent wakeups without merging distinct commands, and persists retry count, next deadline, last error, owner, and fencing token. Retry delay uses deterministic jitter. Exhausted work becomes `failed`; it does not loop forever.

Scheduler compaction creates a new generation containing a checksummed replacement snapshot and an empty event log. The generation is verified before the manifest is atomically activated. The previous generation is retained for recovery.

## Project-local state

```text
.pi/autonomy/state.json                         latest run snapshot
.pi/autonomy/events.jsonl                       checksummed run history
.pi/autonomy/commands.jsonl                     durable worker queue
.pi/autonomy/commands.lock                      queue mutation lock
.pi/autonomy/scheduler/manifest.json             active/previous generation
.pi/autonomy/scheduler/generations/<n>/snapshot.json
.pi/autonomy/scheduler/generations/<n>/events.jsonl
.pi/refinement/ledger.jsonl                     refinement history
.pi/refinement/quarantine.jsonl                 malformed ledger evidence
.pi/python-skills/venvs/<content-hash>/          isolated Python environments
```

Corrupt, non-contiguous, or checksum-mismatched state fails closed. Pantheon does not silently skip damaged evidence.

## Refinement approvals

Refinement is append-only and approval-gated:

```text
proposed → validated → approved → active → rolled_back
```

Validation evidence is required before approval. Activation verifies that the proposal's base hash still matches the current artifact and rejects conflicting active proposals. Rejection, quarantine, and rollback retain their reasons in the ledger. No proposal self-approves.

## Python skill policy

Python skills run under a manifest contract:

- bounded Python version range;
- exact `package==version` dependency pins;
- project-relative `.py` entrypoint;
- JSON-object input and output contracts;
- bounded timeout and output size;
- explicit environment-variable allowlist;
- content-addressed virtual environment cache;
- `network: deny` fails closed unless a network sandbox adapter is available.

The environment hash includes the Python requirement and sorted dependency pins. A second run with the same contract reuses the existing environment.

## Capability-gated OMP state

Two Prime-inspired adapters are present but deliberately report unsupported against stock OMP 17.2.14:

- kernel checkpoints: OMP does not expose public eval-kernel state export/import APIs;
- retained subagents: OMP's public `eval.agent` bridge hard-codes one-shot disposal and exposes no keep-alive option.

Pantheon does not reach into OMP internals or pretend these capabilities work. Injectable backends define the future contract: checkpoints accept bounded JSON-only state and restore atomically into a fresh kernel; retained agents require bounded TTL, owner cleanup, and explicit release.

## Migration from Ralph/ULW runtime

The extension no longer registers the Ralph/ULW promise loop. Use `/autonomy start ...` for persistent execution. Existing `/ultrawork` or `/ulw` prompt commands, if installed, remain orchestration prompts only; they are not a completion or persistence runtime.

Key changes:

- completion promise markers are ignored;
- native OMP goals plus objective gate evidence replace prose-based completion;
- command/session recovery uses the broker-managed worker and durable journals;
- retries are bounded and failed work stays inspectable;
- refinement requires validation and human approval before activation.
