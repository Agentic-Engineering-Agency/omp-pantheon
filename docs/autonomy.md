# Verified autonomy

Pantheon autonomy is an explicit, project-local execution mode built on OMP's public SDK. It persists objective state, resumes queued OMP sessions through a broker-managed worker, and accepts completion only from current objective evidence.

It is opt-in. Normal OMP sessions are unchanged until `/autonomy start` is used.

## Requirements and setup

- Install this bundle so `extensions/oh-my-omp/index.ts` is discovered by OMP.
- Use `@oh-my-pi/pi-coding-agent` 17.2.14 or a compatible 17.x release.
- Start OMP in the target project. Objective/refinement state and Python caches are written beneath that project's `.pi/` directory. Executable worker commands and schedules live in a private per-user state directory, outside the repository.

No global daemon is installed. Starting an autonomy run asks OMP's launch broker to run a run-scoped `pantheon-agentd-<hash>` with `restart: on-failure` and `persist: true`. Terminal success, terminal failure, cancellation, and session shutdown stop that run's worker.

## Commands

```text
/autonomy start <task> [--max-attempts=N] [--verify="command"]
/autonomy status
/autonomy pause
/autonomy resume
/autonomy cancel
/autonomy explain
```

`start` creates a new run, freezes the host verification command (default: `bun test`), and starts the resident worker. A terminal run may be followed by another run; journal revisions remain contiguous. `pause` and `resume` change the run state. `cancel` is terminal and stops the worker. `status` reports the run, attempt, artifact revision, gates, and broker worker state.

## Completion contract

The default run has two gates:

1. `native-goal`: Pantheon first binds the ID of an `active` native OMP goal whose objective exactly matches the autonomy task. It records a pass only when OMP later emits `complete` for that same ID. Unrelated goals are ignored.
2. `verification`: `autonomy_gate` accepts no evidence parameters. It asks the host runner to execute the command frozen by `/autonomy start --verify=...` and records the observed exit status.

Every required gate must pass for the same attempt and artifact revision. Gate reporters are fixed by type (`native-goal-event` or `host-verifier`); model-supplied evidence cannot substitute for either. An artifact change invalidates old evidence. A failed or missing gate causes another bounded attempt; exhausting `maxAttempts` records a terminal failure with evidence.

Model prose is never completion evidence. `<promise>DONE</promise>`, similar markers, and an `agent_end` event cannot complete a run by themselves.

## Worker lifecycle and recovery

`pantheon-agentd` uses only public OMP APIs:

- `SessionManager.open(sessionFile)` reopens persisted session state;
- `createAgentSession(...)` creates the headless session;
- the worker waits for idle, flushes the session manager, then records a persistence receipt before acknowledging work.

Commands are journaled before execution. Each command is bound to one autonomy run, one canonical project root, one absolute session file, and a finite attempt bound. Claims have leases, periodic heartbeats, and monotonically increasing fencing tokens. An interrupted execution is retried only up to its command bound. If execution completes but durable acknowledgement fails, the command becomes terminal `uncertain` instead of being replayed.

The command journal and scheduler are not repository command channels. They live under `${XDG_STATE_HOME:-~/.local/state}/omp-pantheon/autonomy/<project-hash>/<run-id>/`, whose path is derived by the extension and checked again by `pantheon-agentd`. The daemon removes unrelated inherited environment variables before opening OMP sessions.

The scheduler stores absolute deadlines, claims due work before delivery, coalesces equivalent wakeups without merging distinct commands, and persists retry count, next deadline, last error, owner, and fencing token. Retry delay uses deterministic jitter. Exhausted work becomes `failed`; it does not loop forever.

Scheduler compaction creates a new generation containing a checksummed replacement snapshot and an empty event log. The generation is verified before the manifest is atomically activated. The previous generation is retained for recovery.

## Persistent state

Project-local state:

```text
.pi/autonomy/state.json                         latest run snapshot
.pi/autonomy/events.jsonl                       checksummed run history
.pi/refinement/ledger.jsonl                     refinement history
.pi/refinement/quarantine.jsonl                 malformed ledger evidence
.pi/python-skills/venvs/<content-hash>/          isolated Python environments
```

Private per-user operational state:

```text
${XDG_STATE_HOME:-~/.local/state}/omp-pantheon/autonomy/
  <project-hash>/<run-id>/commands.jsonl
  <project-hash>/<run-id>/scheduler/manifest.json
  <project-hash>/<run-id>/scheduler/generations/<n>/snapshot.json
  <project-hash>/<run-id>/scheduler/generations/<n>/events.jsonl
```

Corrupt, non-contiguous, checksum-mismatched, or concurrent stale state fails closed. Run and refinement journals serialize read/check/append transitions; orphaned Python provisioning locks are reclaimed only after their owner is dead and their age exceeds the configured threshold.

## Refinement approvals

Refinement is append-only and approval-gated:

```text
proposed → validated → approved → active → rolled_back
```

Validation evidence is required before approval. Activation verifies that the proposal's base hash still matches the current artifact and serializes conflict detection with the append, so only one proposal can become active per artifact. Rejection, quarantine, and rollback retain their reasons in the ledger. No proposal self-approves.

## Python skill policy

Python skills run under a manifest contract:

- bounded Python version range;
- exact `package==version` dependency pins;
- project-relative `.py` entrypoint;
- JSON-object input and output contracts;
- bounded timeout and output size;
- environment variables require both a manifest request and a host-owned allowlist;
- content-addressed virtual environment cache with stale-owner lock recovery;
- bounded provisioning subprocesses with a scrubbed environment;
- `network: deny` fails closed unless a network sandbox adapter is available, and uncached dependencies are never installed for a network-denied skill.

The environment hash includes the Python requirement and sorted dependency pins. A second run with the same contract reuses the existing environment. The manifest cannot self-authorize access to host secrets.

## Capability-gated OMP state

Two Prime-inspired adapters are present but deliberately report unsupported against stock OMP 17.2.14:

- kernel checkpoints: OMP does not expose public eval-kernel state export/import APIs;
- retained subagents: OMP's public `eval.agent` bridge hard-codes one-shot disposal and exposes no keep-alive option.

Pantheon does not reach into OMP internals or pretend these capabilities work. Injectable backends define the future contract: checkpoints accept bounded JSON-only state and restore atomically into a fresh kernel; retained agents require bounded TTL, caller/owner session matching, owner cleanup, and explicit release.

## Migration from Ralph/ULW runtime

The extension no longer registers the Ralph/ULW promise loop. Use `/autonomy start ...` for persistent execution. Existing `/ultrawork` or `/ulw` prompt commands, if installed, remain orchestration prompts only; they are not a completion or persistence runtime.

Key changes:

- completion promise markers and model-authored gate evidence are ignored;
- one exact native OMP goal plus a host-run verification command replace prose-based completion;
- command/session recovery uses a run-scoped broker worker and a private durable journal;
- leases are renewed during execution; retries are bounded; uncertain and failed work stays inspectable;
- refinement requires validation and approval before serialized activation.
