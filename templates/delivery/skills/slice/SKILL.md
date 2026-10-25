---
name: slice
description: "Use when work is requested, when anything is raised in passing (bug, idea, follow-up, risk), when a goal or done condition is unclear, or when the current slice is done. Files it at once, frames it with at most {{values.questions.max}} questions, and writes one child issue per PR-sized slice with six required sections and its deps."
---

# slice

## Intake: file before you forget

```
forge issue create --input '{"title":"...","kind":"task","labels":["p2"],"parent":"<epic id>","body":"..."}'
```

- Kind: `task`, `bug`, `feature` or `epic`. Priority is one label of {{values.labels.priority}}.
- File it and move on. Do not fix it in the current slice.

## Frame, only when the done condition cannot be stated

- Facts are your job: read the code, and `forge memory search --input '{"query":"...","scope":"<name>"}'` and `forge decision list --input '{}'` for prior choices. Use the lowercase repo name from `gh repo view --json name --jq '.name|ascii_downcase'` as `<name>`.
- Choices are the owner's. Ask at most {{values.questions.max}} lettered questions, each with a default. Silence means every default.
- Record each answer: `forge decision propose --input '{"title":"...","text":"..."}'`. On `format_missing`, follow the returned `repair`, then propose again. Only after `proposed`, hand it to a human for adoption.
- Plan in depth only for the one or two hard choices.

## Slice body: all six sections

1. **Behaviour**: what changes, end to end, as a user sees it.
2. **Failing check**: the named check that fails before the change and passes after.
3. **Done boundary**: what is in. Anything beyond it is filed, not fixed.
4. **Touches / Needs / Owns**: files and areas read, required from main, and written.
5. **Door**: reversible, or one-way ({{values.doors}}).
6. **Size**: estimate. Target {{values.slice.targetLines}} changed lines and at most {{values.slice.maxFiles}} files. Above {{values.slice.splitAbove}} lines, split before building.

## Order

- A need missing from main becomes its own contract slice, and goes first. Create the dependent slice with `"dependsOn":["<contract slice id>"]`. Later edits use `forge issue dep --input '{"id":"<slice>","target":"<dep>","action":"add","expectRevision":<n>}'`, which needs the claim and the revision from `forge issue show`.
- Split along natural seams: engine and its unit tests, then the surface, then end-to-end journeys. Each slice ships green alone.
- Uncertain work goes last.
- Rename or remove work: search the whole repo first and list every hit under Touches.

## When a slice is done

Re-plan: take the next ready slice (`forge issue ready --input '{}'`), re-slice, re-frame, or close slices it superseded with `forge issue close --input '{"id":"<id>","withoutReceipt":"superseded by <id>"}'` (close needs the claim). Any caller may use `withoutReceipt` for an explicit written reason; it is stored on the issue and does not claim delivery evidence.
