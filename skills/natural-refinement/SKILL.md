---
name: natural-refinement
description: Prepare a human-approved refinement from a natural-language request. Use when a user wants to improve an agent, skill, prompt, command, or harness behavior and asks for a preview before approval.
---

# Natural refinement

Use this workflow to turn an observed, recurring harness failure into one
reviewable and reversible refinement. It changes the harness, not product code
or model weights.

## Workflow

1. Identify one project-relative harness artifact and explain the recurring
   behavior it should correct. Do not use this for a one-off product bug.
2. Read the current artifact and write a separate project-relative candidate
   file. Never overwrite the artifact during preparation.
3. Run the smallest relevant verification and retain its exact evidence
   reference. EvalFly evidence is preferred when available; a named test report
   is acceptable when it covers the changed behavior.
4. Call `refinement_preview` with the artifact path, candidate path, and
   evidence reference. It returns the complete JSON transaction and changes
   neither the artifact nor the refinement ledger.
5. Show the returned JSON transaction unchanged. State that the user must
   submit exactly `aprobar` to apply it or exactly `cancelar` to discard it.
   Do not call `/refinement approve`, `/refinement activate`, or any equivalent
   activation path yourself.

## Approval boundary

- Only an interactive user message exactly equal to `aprobar` activates the
  prepared preview.
- A preview is session-scoped, cannot be replaced until it is approved or
  discarded, and is invalidated if the artifact or candidate changes before
  approval.
- If the user declines or requests edits, ask them to submit exactly
  `cancelar`, update the candidate, re-run verification, and create a fresh
  preview.
- A preview has no side effects; approval executes the existing append-only
  proposal, validation, approval, and activation lifecycle.

## Response shape

Before approval, show only:

```text
Artifact: <path>
Candidate: <path>
Evidence: <reference>
JSON transaction:
<tool output verbatim>

Submit exactly `aprobar` to activate this candidate, or exactly `cancelar` to discard this preview.
```

After approval, report the proposal ID and that the candidate is active. If the
runtime rejects approval because either file drifted, explain the drift and
prepare a new preview; never retry activation automatically.
