---
name: specsafe
description: Slice lifecycle CLI for SpecSafe — begin, end, and inspect the open slice in `.pi/.specsafe-state.json`.
---

# specsafe skill

Manages the SpecSafe slice lifecycle by mutating `.pi/.specsafe-state.json` in the current working directory. State-file shape is identical to the vanilla-Pi `.pi/extensions/specsafe-session` extension; types are imported from `.omp/hooks/specsafe-session` so drift is caught by `tsc`.

## Subcommands

### begin \<slice-id\> \<workspace-id\> \<session-id\>

Open a new slice. Fails with exit 1 if a slice is already open.

```
bun run .omp/skills/specsafe/bin/specsafe.ts begin SPEC-20260427-009 ws-abc sess-123
```

Writes `currentSlice` with a freshly zeroed `costCounter` and `beganAt` set to `new Date().toISOString()`. History is preserved.

### end \<PASS|FAIL|ABANDONED\>

Archive the open slice into `history` with the given outcome and clear `currentSlice`. Fails with exit 1 if no slice is open. Outcome must be exactly one of `PASS`, `FAIL`, `ABANDONED`.

```
bun run .omp/skills/specsafe/bin/specsafe.ts end PASS
```

The archived `HistoryEntry.costSummary` is a by-value copy of the slice's `costCounter` at end-time.

### status

Print whether a slice is open and the number of history entries.

```
bun run .omp/skills/specsafe/bin/specsafe.ts status
```

Output is one of:

```
OPEN: <slice-id>
<n> history entries
```

```
no slice open
<n> history entries
```

## State file

- Path: `.pi/.specsafe-state.json` (resolved via `statePathFor(process.cwd())`).
- Mode: `0600`, enforced after every write.
- Atomic write: temp file `<path>.tmp-<pid>-<ts>` + `renameSync` + explicit `chmodSync`.
- Corrupt JSON is quarantined as `<path>.corrupt-<timestamp>` (via `readStateFileOrNull`); the CLI then proceeds as if state were empty.

## Exit codes

| Code | Meaning                                                        |
|------|----------------------------------------------------------------|
| 0    | Success                                                        |
| 1    | Lifecycle violation (`begin` while open, `end` while closed)   |
| 2    | Usage error (missing/unknown subcommand or argument)           |

## Implementation notes

This CLI is the Oh My Pi counterpart to the vanilla-Pi `specsafe_begin`/`specsafe_end`/`specsafe_status` ExtensionAPI tools registered by `.pi/extensions/specsafe-session/index.ts`. Both writers target the same project state file. The CLI initializes but does not mutate the cost counter; external memory accounting is not included in this public bundle.
