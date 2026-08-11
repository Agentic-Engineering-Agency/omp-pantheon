# Verified autonomy

Pantheon autonomy is an explicit, project-scoped execution mode built on OMP's public SDK. It persists objective state in private per-user storage, resumes queued OMP sessions through a broker-managed worker, and accepts completion only from current objective evidence.

It is opt-in. Normal OMP sessions are unchanged until `/autonomy start` is used.

## Requirements and setup

- Install this bundle so `extensions/oh-my-omp/index.ts` is discovered by OMP.
- Use `@oh-my-pi/pi-coding-agent` 17.2.14 or a compatible 17.x release.
- Start OMP in the target project. Objective, worker, Python environment, and SpecSafe receipt state are written to private per-user storage; refinement history remains beneath that project's `.pi/` directory.

No global daemon is installed. Starting an autonomy run asks OMP's launch broker to run a run-scoped `pantheon-agentd-<hash>` with `restart: on-failure` and `persist: true`. An active run survives parent-session shutdown so queued work can resume. Terminal success, terminal failure, and cancellation stop that run's worker.

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

Every run always has two core gates and conditionally freezes the active project contracts at start:

1. `native-goal`: Pantheon first binds the ID of an `active` native OMP goal whose objective exactly matches the autonomy task. It records a pass only when OMP later emits `complete` for that same ID. Unrelated goals are ignored.
2. `verification`: `autonomy_gate` accepts no evidence parameters. It asks the host runner to execute the command frozen by `/autonomy start --verify=...` and records the observed exit status.
3. `evalfly`: when EvalFly enforcement is active at start, Pantheon captures its suite, commit range, and activation time. The adapter requires a canonical passing run/report that exactly matches that contract and is newer than activation. Disabling or replacing the captured enforcement contract does not waive the gate.
4. `specsafe`: when an exact SpecSafe slice is open at start, Pantheon captures its slice instance (ID and `beganAt`) plus gate activation time. The adapter passes only when project history contains exactly one matching `PASS`, that instance is no longer open, and the bundled SpecSafe CLI has emitted a matching immutable closure receipt in private per-user state after activation. If closure is interrupted after receipt publication, retrying `specsafe end` reuses that receipt and repairs an interrupted temporary hard link before finishing project history. Project-file edits, stale receipts, duplicate instance history, reopened IDs, and different or failed slices do not satisfy it.

Configured EvalFly and SpecSafe adapters refresh at `agent_end` before completion is evaluated. Malformed configured state rejects `/autonomy start`; unavailable, stale, or mismatched evidence fails closed.

Every required gate must pass for the same attempt and artifact revision. Gate reporters are fixed by type (`native-goal-event`, `host-verifier`, `evalfly-adapter`, or `specsafe-adapter`); model-supplied evidence cannot substitute for them. Every potentially mutating tool result advances the artifact revision and resets all gates, whether that tool reports success or failure. Only known read-only tools (`read`, `grep`, and `glob`) plus the `goal` control tool and `autonomy_gate` are exempt. Unknown tools are treated as mutating, so verification must run after the last mutation. A failed or missing gate causes another bounded attempt; exhausting `maxAttempts` records a terminal failure with evidence.

Model prose is never completion evidence. `<promise>DONE</promise>`, similar markers, and an `agent_end` event cannot complete a run by themselves.

## Worker lifecycle and recovery

`pantheon-agentd` uses only public OMP APIs:

- `SessionManager.open(sessionFile)` reopens persisted session state;
- `createAgentSession(...)` creates the headless session;
- the worker waits for idle, flushes the session manager, then records a persistence receipt before acknowledging work.

Commands are journaled before execution. Each command is bound to one autonomy run, one canonical project root, one absolute session file, and a finite attempt bound. When an attempt ends without current gate evidence, the extension durably schedules a continuation before returning; `pantheon-agentd` claims it and reopens that exact session. Claims have leases, periodic heartbeats, and monotonically increasing fencing tokens. An interrupted execution is retried only up to its command bound. If execution completes but durable acknowledgement fails, the command becomes terminal `uncertain` instead of being replayed.

Objective state, the command journal, and the scheduler are not repository command channels. They live under `${XDG_STATE_HOME:-~/.local/state}/omp-pantheon/autonomy/<project-hash>/`. The extension creates directories with mode `0700` and files with mode `0600`. Paths are derived by the extension and checked again by `pantheon-agentd`; the daemon removes unrelated inherited environment variables before opening OMP sessions.

The scheduler stores absolute deadlines, claims due work before delivery, coalesces equivalent wakeups without merging distinct commands, and persists retry count, next deadline, last error, owner, and fencing token. Retry delay uses deterministic jitter. Exhausted work becomes `failed`; it does not loop forever.

Scheduler compaction creates a new generation containing a checksummed replacement snapshot and an empty event log. The generation is verified before the manifest is atomically activated. The previous generation is retained for recovery.

## Persistent state

Project-local state:

```text
.pi/refinement/ledger.jsonl                     refinement history
.pi/refinement/quarantine.jsonl                 malformed ledger evidence
.pi/refinement/snapshots/<proposal-id>.json       rollback bytes, mode, and checksum
```

Private per-user operational state:

```text
${XDG_STATE_HOME:-~/.local/state}/omp-pantheon/
  autonomy/<project-hash>/state/state.json
  autonomy/<project-hash>/state/events.jsonl
  autonomy/<project-hash>/runs/<run-id>/commands.jsonl
  autonomy/<project-hash>/runs/<run-id>/scheduler/manifest.json
  autonomy/<project-hash>/runs/<run-id>/scheduler/generations/<n>/snapshot.json
  autonomy/<project-hash>/runs/<run-id>/scheduler/generations/<n>/events.jsonl
  python-skills/<project-hash>/venvs/<content-hash>/
  specsafe/<project-hash>/closures/<instance-hash>.json
```

Corrupt, non-contiguous, checksum-mismatched, symlinked state, or concurrent stale state fails closed. Run and refinement journals serialize read/check/append transitions. File-lock ownership is backed by a SQLite transaction, so a crashed owner releases the serialization guard without an orphaned breaker; the guard database and its sidecars must be singly linked regular files, and every acquisition forces `DELETE` journaling before locking. Old JSON lock metadata is reclaimed only after its owner is dead and its age exceeds the configured threshold. The controller also keeps the authoritative run state in process memory after loading it, so ordinary model-facing tool calls cannot replace it through project files.

This is not a security boundary against arbitrary native code already running as the same OS user: such code can access that user's private state. The boundary protects the normal model tool surface, prevents repository content from acting as an executable queue, rejects project-state symlinks, and limits accidental disclosure to other local users. Run untrusted native code in an OS sandbox.

## Refinement approvals

Refinement is append-only and approval-gated:

```text
proposed → validated → approved → active → rolled_back
```

Validation evidence is required before approval. Approval is a host-adapter operation, not a registered model tool; `approvedBy` records the trusted host identity supplied by that adapter and is provenance, not independent authentication. Activation verifies the actual artifact bytes against the proposal's base hash, writes a checksummed rollback snapshot, and serializes conflict detection with the ledger append; the trusted host adapter applies the separately validated candidate content. Rollback restores the snapshotted bytes and mode atomically only when the artifact still matches either the approved candidate hash or an already-restored base hash, so unrelated edits fail closed. Rejection, quarantine, and rollback retain their reasons in the ledger. No proposal self-approves.

## Python skill policy

Python skills run under a manifest contract:

- bounded Python version range;
- exact `package==version` dependency pins;
- project-relative `.py` entrypoint that resolves to a singly linked regular file below the canonical, non-symlinked skill root, with no symlinked path component;
- JSON-object input and output contracts; input is serialized and revalidated before provisioning or process spawn;
- bounded timeout and output size;
- environment variables require both a manifest request and a host-owned allowlist;
- content-addressed virtual environment cache in private per-user state with stale-owner lock recovery;
- cache reuse requires a checksummed environment marker whose contract and current Python executable hash match; repository writes cannot alter cached dependency code, and symlinked, hard-linked, escaped, or non-regular cache control artifacts fail closed;
- bounded provisioning subprocesses with a scrubbed environment;
- runner and provisioning subprocesses use dedicated process groups; timeout and output-limit failures terminate the whole process tree;
- `network: deny` fails closed unless a network sandbox adapter is available, and uncached dependencies are never installed for a network-denied skill;
- duplicate skill IDs are rejected across a loaded manifest collection.

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
