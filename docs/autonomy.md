# Verified autonomy

Pantheon autonomy is an explicit, project-scoped execution mode built on OMP's public SDK. It persists objective state in private per-user storage, resumes queued OMP sessions through a broker-managed worker, and accepts completion only from current objective evidence.

It is opt-in. Normal OMP sessions are unchanged until `/autonomy start` is used.

## Requirements and setup

- Install this bundle so `extensions/oh-my-omp/index.ts` is discovered by OMP.
- Use `@oh-my-pi/pi-coding-agent` 17.2.14 or a compatible 17.x release.
- Start OMP in the target project. Objective, worker, Python environment, and SpecSafe receipt state are written to private per-user storage; refinement history remains beneath that project's `.pi/` directory.
- Use a persisted OMP session. `/autonomy start` rejects OMP's `--no-session`
  mode before writing objective state or starting the worker; ownerless durable
  continuation is unsupported and fails closed.

No global daemon is installed. Starting an autonomy run asks OMP's launch broker to run a run-scoped `pantheon-agentd-<hash>` with `restart: on-failure` and `persist: true`. An active run survives parent-session shutdown so queued work can resume. Externally initiated terminal transitions first fence the worker; a terminal transition emitted by the resident worker uses the acknowledged natural-exit handshake described below.

## Commands

```text
/autonomy start <task> [--max-attempts=N] [--verify="command"]
/autonomy status
/autonomy pause
/autonomy resume
/autonomy cancel
/autonomy explain
```

`start` creates a new run, freezes the host verification command (default: `bun test`), and starts the resident worker. The run becomes `paused` with concrete bootstrap evidence if worker startup fails; it is never left falsely `running`. A terminal run may be followed by another run; journal revisions remain contiguous. An externally initiated `pause` persists the paused state only after the run-scoped worker reports a terminal stop (`exited` or `failed`; `stopped` is accepted for compatible adapters), and verification is rejected while paused. Mutating tool results observed while paused still advance the artifact revision and reset every gate without resuming execution. `resume` restarts the worker before scheduling continuation; either bootstrap failure stops the worker best-effort and restores `paused` with the failure evidence. Every invalidated gate requires fresh evidence. An externally initiated `cancel` likewise requires a terminal worker state before persistence.

## Completion contract

Every run always has two core gates and conditionally freezes the active project contracts at start:

1. `native-goal`: Pantheon first binds the ID of an `active` native OMP goal whose objective exactly matches the autonomy task. It records a pass only when OMP later emits `complete` for that same ID. Unrelated goals are ignored.
2. `verification`: `autonomy_gate` accepts no evidence parameters. It asks the host runner to execute the command frozen by `/autonomy start --verify=...` and records the observed exit status.
3. `evalfly`: when EvalFly enforcement is active at start, Pantheon captures its suite, commit range, and activation time. The adapter requires a canonical passing run/report that exactly matches that contract and is newer than activation. Disabling or replacing the captured enforcement contract does not waive the gate.
4. `specsafe`: when an exact SpecSafe slice is open at start, Pantheon captures its slice instance (ID and `beganAt`) plus gate activation time. The adapter passes only when project history contains exactly one matching `PASS`, that instance is no longer open, and the bundled SpecSafe CLI has emitted a matching immutable closure receipt in private per-user state after activation. If closure is interrupted after receipt publication, retrying `specsafe end` reuses that receipt and repairs an interrupted temporary hard link before finishing project history. Project-file edits, stale receipts, duplicate instance history, reopened IDs, and different or failed slices do not satisfy it.

Configured EvalFly and SpecSafe adapters refresh at `agent_end` before completion is evaluated. Malformed configured state rejects `/autonomy start`; unavailable, stale, or mismatched evidence fails closed.

Every required gate must pass for the same attempt and artifact revision. Gate reporters are fixed by type (`native-goal-event`, `host-verifier`, `evalfly-adapter`, or `specsafe-adapter`); model-supplied evidence cannot substitute for them. Gate writes merge under the state lock, so concurrent evidence for different gates is preserved. Every potentially mutating tool result advances the artifact revision and resets all gates, whether that tool reports success or failure. The fixed host verification command is fingerprinted against Git-tracked, staged, and untracked artifact bytes and executable modes before and after execution; its detached process group is terminated before the post-command sample, preventing delayed descendants from mutating after the receipt. A command that mutates artifacts advances the revision and invalidates earlier gates before its own receipt is recorded, and that transition is rejected if another mutation races with verification. Only known read-only tools (`read`, `grep`, and `glob`) plus the `goal` control tool and `autonomy_gate` are exempt from tool-result invalidation. Unknown tools are treated as mutating.

Model prose is never completion evidence. `<promise>DONE</promise>`, similar markers, and an `agent_end` event cannot complete a run by themselves.

## Worker lifecycle and recovery

`pantheon-agentd` uses only public OMP APIs:

- `SessionManager.open(sessionFile)` reopens persisted session state;
- `createAgentSession(...)` creates the headless session;
- the worker waits for idle, flushes the session manager, then records a persistence receipt before acknowledging work.

Commands are journaled before execution. A worker first leases a command as `claimed`, then durably records `dispatched` immediately before calling the headless prompt. Expired `claimed` work may be fenced and retried; `dispatched` work is never reclaimed. A daemon restart marks orphaned dispatches `uncertain` instead of replaying possible side effects. Every run records the canonical persisted OMP owner session file in private state; `--no-session` cannot start a run. Positive goal/verification evidence and `agent_end` attempt/continuation decisions are evaluated against the context that emitted each event, so switching the loaded runtime to another session cannot transfer ownership. Mutating tool results remain project-wide invalidation signals: a write from any session sharing the canonical project root advances the artifact revision and resets every gate. Project identity is canonicalized through the filesystem before state derivation and ownership checks, so symlink aliases share one run. Project attachment prepares a complete controller/store/worker context before atomically replacing the prior attachment; failed replacement preserves the prior runtime. Private state-home paths must themselves be owned directories, never symlinks.

Terminalization is ownership-aware and crash-consistent. An external OMP session must receive a terminal broker state before it persists success, bounded failure, pause, or cancellation. The resident `pantheon-agentd` session instead records a terminal intent bound to its claimed command inside `agent_end`, then returns from the handler. The headless executor waits for idle, flushes the session, writes the persistence receipt, and acknowledges the command before the daemon finalizes that intent. Once terminal intent exists, only `finalizeTerminalIntent` or `failTerminalIntent` may clear it; ordinary controller mutations and unrelated external `agent_end` events cannot bypass the journal. External pause/cancel/success/failure paths stop the worker, reload authoritative state, require the original run ID to remain current, and reconcile any pending command before applying an ID-scoped transition. A terminal intent created while the broker is stopping is therefore reconciled, and a replacement run cannot be terminalized by its predecessor's request. Only an acknowledged command may finalize its intent; missing, queued, failed, uncertain, or orphaned claimed work fails the objective instead of being replayed. The worker exits naturally after finalization and before another claim. Missing state or a different current run also stops the old worker, so it cannot consume a replacement run's work. Resident run/command identity is process-global under a versioned `Symbol.for(...)` key so it remains visible across OMP's cache-busted extension module identities. Runtime controllers reload private state at operation boundaries so external sessions observe cross-process finalization.

Once headless prompt dispatch begins, any thrown prompt, idle, flush, disposal,
heartbeat, receipt, or acknowledgement failure is an ambiguous completion:
tool side effects may already exist. The journal marks that command `uncertain`
and never releases it for retry. Only failures known to occur before prompt
dispatch remain retryable.

Objective state, the command journal, and the scheduler are not repository command channels. They live under `${XDG_STATE_HOME:-~/.local/state}/omp-pantheon/autonomy/<project-hash>/`. The extension creates directories with mode `0700` and files with mode `0600`. Paths are derived by the extension and checked again by `pantheon-agentd`; the daemon removes unrelated inherited environment variables before opening OMP sessions.

The scheduler stores absolute deadlines, claims due work before delivery, coalesces equivalent wakeups without merging distinct commands, and persists retry count, next deadline, last error, owner, and fencing token. Retry delay uses deterministic jitter. Exhausted work becomes `failed`; it does not loop forever.

Scheduler compaction creates a new generation containing a checksummed replacement snapshot and an empty event log. The generation is verified before the manifest is atomically activated. The previous generation is retained for recovery.

## Persistent state

Project-local state:

```text
.pi/refinement/ledger.jsonl                     refinement history
.pi/refinement/quarantine.jsonl                 malformed ledger evidence
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
  refinement/<project-hash>/snapshots/<proposal-id>.json
  python-skills/<project-hash>/venvs/<content-hash>/
  specsafe/<project-hash>/closures/<instance-hash>.json
```

Corrupt, non-contiguous, checksum-mismatched, symlinked state, or concurrent stale state fails closed. Run and refinement journals serialize read/check/append transitions. File-lock ownership is backed by a SQLite transaction, so a crashed owner releases the serialization guard without an orphaned breaker; the guard database and its sidecars must be singly linked regular files, and every acquisition forces `DELETE` journaling before locking. Old JSON lock metadata is reclaimed only after its owner is dead and its age exceeds the configured threshold. Controllers reload the authoritative private run state at operation boundaries, scope delayed evidence and transitions to the captured run ID, and bind event-derived mutations to the persisted owner session so cross-process terminalization and replacement runs are immediately visible without cross-session takeover.

This is not a security boundary against arbitrary native code already running as the same OS user: such code can access that user's private state. The boundary protects the normal model tool surface, prevents repository content from acting as an executable queue, rejects project-state symlinks, and limits accidental disclosure to other local users. Run untrusted native code in an OS sandbox.

## Refinement approvals

Refinement is append-only and approval-gated:

```text
proposed → validated → approved → active → rolled_back
```

Validation evidence is required before approval. Approval is a host-adapter operation, not a registered model tool; `approvedBy` records the trusted host identity supplied by that adapter and is provenance, not independent authentication. Activation accepts the separately validated candidate bytes, verifies their exact proposal content hash and the artifact's base hash, writes a checksummed rollback snapshot, atomically installs the candidate with a final drift check, then records `active` under the same ledger lock. If execution stops after installation but before the ledger append, retrying activation recognizes the exact candidate bytes plus valid snapshot and completes the missing event without rewriting the artifact. Rollback restores the snapshotted bytes and mode atomically only when the artifact still matches either the approved candidate hash or an already-restored base hash, so unrelated edits fail closed. Rejection, quarantine, and rollback retain their reasons in the ledger. No proposal executes itself.

The installed extension exposes this lifecycle only as the human slash command
`/refinement`; no model-callable refinement tool exists. Use `list`, or pass one
JSON object for a transition:

```text
/refinement {"action":"propose","artifact":"skills/x/SKILL.md","candidate":"candidate.md","author":"agent:refiner","source":"evalfly:run-id"}
/refinement {"action":"validate","id":"proposal-id","evidence":"evalfly:report-id"}
/refinement {"action":"approve","id":"proposal-id","approvedBy":"user:name"}
/refinement {"action":"activate","id":"proposal-id","candidate":"candidate.md"}
/refinement {"action":"reject","id":"proposal-id","reason":"reason"}
/refinement {"action":"rollback","id":"proposal-id","reason":"reason"}
/refinement {"action":"quarantine","id":"proposal-id","reason":"reason"}
```

Artifact and candidate inputs must be project-relative, non-symlinked,
singly-linked regular files. Rollback bytes live only in private per-user state,
not in Git-visible project state.

## Python skill policy

Python skills run under a manifest contract:

- bounded Python version range;
- exact `package==version` dependency pins;
- one project-root `.py` entrypoint approved as a singly linked regular file below the canonical, non-symlinked skill root; after environment provisioning the runner reopens it with `O_NOFOLLOW`, verifies descriptor identity and approved hash, and executes a private staged copy under isolated Python startup;
- JSON-object input and output contracts; input is serialized and revalidated before provisioning or process spawn;
- bounded timeout and output size;
- environment variables require both a manifest request and a host-owned allowlist;
- content-addressed virtual environment cache in private per-user state with stale-owner lock recovery;
- cache reuse requires a checksummed environment marker whose contract and current Python executable hash match; repository writes cannot alter cached dependency code, and symlinked, hard-linked, escaped, or non-regular cache control artifacts fail closed;
- bounded provisioning subprocesses with a scrubbed environment, extension-owned working directory, isolated Python startup, and bounded stdout/stderr collectors;
- verification, runner, and provisioning subprocesses use dedicated process groups; cancellation, timeout, and output-limit failures terminate the whole process tree, and cancellation throws instead of recording a failed verification receipt;
- `network: deny` fails closed unless a network sandbox adapter is available, and uncached dependencies are never installed for a network-denied skill;
- duplicate skill IDs are rejected across a loaded manifest collection.

The environment hash includes the Python requirement and sorted dependency pins. A second run with the same contract reuses the existing environment. The manifest cannot self-authorize access to host secrets.

Install a skill at `.omp/python-skills/<directory>/manifest.json` with its
project-root entrypoint beside the manifest. The installed extension exposes
`/python-skill list` and:

```text
/python-skill run {"id":"skill-id","input":{"key":"value"}}
```

This is a human slash-command bridge, not a model-callable tool. Every component
from the canonical project root through `.omp/python-skills` must be a real
directory, and the runner rechecks that the canonical skill root remains inside
that project before execution. Duplicate IDs are rejected. Stock Pantheon has
no network sandbox adapter, so a manifest declaring `network: deny` is rejected
rather than run.

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
