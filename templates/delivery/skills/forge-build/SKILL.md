---
name: forge-build
description: "Claim and build one slice with red/green receipts, risk-scaled proof and a ready PR. Stops at push; never merges."
---

# forge-build

Read [pull-request.md](pull-request.md) for setup and PR handoff.

Every wake runs `forge pr state <n>` and acts on `verdict`.

## Worker brief

Before each call run `forge issue call --input '{"id":"<slice>","role":"<role>"}'`; LIMIT_REACHED ends the intent: report, start nothing. Retry REVISION_CONFLICT.

Fill every field before delegating; an empty field blocks the call:

```
Goal: <slice id and end state; read forge issue show for the spec>
Scope: <Owns and done boundary>
Context: <Touches / Needs, adopted decision titles and checkpoint>
Acceptance: <observable pass predicates>
Verify: <named red/green check, risk band, scenario and final-head checks>
Timebox: `forge issue call`'s timeboxMinutes (at most 45 minutes); stop and report the checkpoint when timeboxMinutes expire, never later than stopBy.
Forbidden: pass named environment variables only, never the whole environment or secret values; stop at push; never merge or merge base unless asked.
Report: <head, receipts, saved output and not checked>
Standing rules: <adopted rules; layer 1 passes the memory packet>
```

## Red, then green

1. Before editing, read `forge issue resume <slice>` and all Touches files; later comments override the body. Use forge-cut's risk band: light 0-1, standard 2-3, heavy 4-5.
2. Every slice goes red then green. Name a check that can fail for the right reason: its expected value is independent of the implementation. Add the new assertion first, run against trunk, and verify it fails on that assertion, not setup or an unrelated failure.
3. `forge check run --input '{"checks":["<name>"]}'`. Expect exit 1 and `ok:false` for FAIL (exit 2 for INCOMPLETE or NOT_EXECUTED); keep the full `result` receipt and its id even on nonzero exit. PASS alone exits 0. Do not chain red checks with `&&` or discard their output on failure.
4. Make the smallest change that turns it green. Run it again; keep that receipt id too. Commit in small conventional commits.

Three proof levels, scaled to risk:

- **Light, not user-visible**: the independent red/green assertion plus the final-head receipt.
- **User-visible, including standard slices** (UI, CLI output, API response, published package): also save one scenario on the built artifact as users get it, with a pass predicate and output.
- **Heavy or critical**: always run that scenario on trunk and head, even without a user-visible change, and get a fresh-context review against every acceptance item through `forge-review` before opening.

"Should pass" and "was passing" are not evidence. A receipt is. Unknown, truncated or zero-test output is not a pass.

## Boundary and stuck checks

- Unrelated findings: search open issues first, then file or comment with a priority label. Never fix them here.
- Before push, compare `git diff --name-only origin/main...HEAD` with Owns. A file outside Owns, or a need missing from main, means file a `contract-gap` issue, add a failing test that pins the gap, and stop.
- After 2 failed fixes on the same check, stop editing. Write the premise with `forge issue comment --input '{"id":"<slice>","body":"premise: ..."}'`, test it directly, then re-slice or escalate.
- Long processes run in the background with a timeout. Edit with the editor tool or a script file, never long inline shell strings. Checkpoint on the issue and restart clean when needed.

## Final-head proof

Read `forge check list --input '{}'`. Run all configured `receiptChecks` on the final tree: `forge check run --input '{"checks":["<name>"]}'`; if empty, pick a relevant declared check. Run the slice regression; CI carries remaining project checks. Require exit 0, `ok:true` and receipt status PASS. Read `forge check show --input '{"id":"<receipt>"}'`; its subject must equal your head. Show alone is not PASS.
