---
name: forge-build
description: "Build; stop at push; never merge."
---

# forge-build

[PR setup](pull-request.md).

Every wake runs `forge pr state <n>` and acts on `verdict`.

## Worker brief

Before each call run `forge issue call <slice> --role <role>`; LIMIT_REACHED ends intent: report, start nothing. Retry REVISION_CONFLICT.

Fill every field before delegating; an empty field blocks the call:

```
Goal: <slice and end state; read forge issue show>
Scope: <Owns and done boundary>
Context: <Touches / Needs, adopted decisions, checkpoint>
Acceptance: <observable pass predicates>
Verify: <named red/green check, risk band, scenario and final-head checks>
Timebox: `forge issue call`'s timeboxMinutes (at most 45 minutes); stop and report the checkpoint when timeboxMinutes expire, never later than stopBy.
Forbidden: pass named environment variables only, never the whole environment or secret values; stop at push; never merge or merge base unless asked.
Report: <head, receipts, output, not checked>
Standing rules: <adopted rules; layer 1 passes the memory packet>
```

## Red, then green

First commit/push: `forge accounts plan --json`; relay `result.ask`, wait. Follow [reply routing](accounts.md) with `approval: {quote, source}`. Bound/declined: continue.

1. Read `forge issue resume <slice>` and every Touches file before editing; later comments override the body. Read `forge issue comments <slice>` once before acting if a checkpoint exists or `more` is true. forge-cut risk: light 0-1, standard 2-3, heavy 4-5.
2. Reproduce the issue (or read the code named) before editing. Log: `forge issue comment --input '{"id":"<slice>","body":"premise holds: <evidence>"}'` or `premise does not hold: <evidence>`; if false, stop and report; change no code.
3. Every slice goes red then green. Name a check's implementation-independent expected value. Run the new assertion on trunk first; it must fail on that assertion, not setup or unrelated errors.
4. `forge check run --input '{"checks":["<name>"]}'`. FAIL: exit 1, `ok:false`; INCOMPLETE/NOT_EXECUTED: exit 2; only PASS exits 0. Keep full `result`/receipt id, even nonzero. No `&&` red chains or discarded failure output.
5. Smallest fix; rerun green; save receipt. Conventional commits.

Three proof levels:

- **Light, not user-visible**: independent red/green assertion plus final-head receipt.
- **User-visible, including standard slices** (UI, CLI output, API response, published package): Save one scenario on the built artifact as users get it, with a pass predicate and output; if `.forge/verify.md` exists, take that scenario from it, run its declared check with `forge check run`, save its named evidence and list the evidence paths in a slice comment.
- **Heavy or critical**: always run that scenario on trunk and head, even without a user-visible change, and get a fresh-context review against every acceptance item through `forge-review` before opening.

Receipts are evidence. Unknown, truncated or zero-test output never passes.

## Boundary and stuck checks

- Unrelated findings: search open issues first, then file/comment with a priority label. Never fix them here.
- Before push, compare `git diff --name-only <base-ref>...HEAD` with Owns. Outside Owns or a need missing from base: file a `contract-gap` issue, pin the gap with a failing test, and stop.
- After 2 failed fixes on the same check, stop editing. Record as above; test directly; re-slice or escalate.
- Background long processes with a timeout. Use editor or script files, never long inline shell strings. Checkpoint before restarting.

## Final-head proof

`forge check list --input '{}'`. Step 4: all final-tree `receiptChecks`; if none, a relevant declared check. Run slice regression; CI carries remaining project checks. Require exit 0, `ok:true`, receipt PASS. `forge check show --input '{"id":"<receipt>"}'` subject must be head. Show alone is not PASS.
