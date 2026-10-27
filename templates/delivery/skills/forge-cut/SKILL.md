---
name: forge-cut
description: "Use when work is requested, raised in passing, or a slice is done. Route an unclear goal or done condition to forge-intake before filing; cut settled work into a graph of demoable, one-context slices."
---

# forge-cut

## Intake: file before you forget

Before filing, route an unclear goal or done condition to forge-intake. Route open decisions to `forge-intake`; read [framing.md](framing.md) for facts and decision records before slicing.

```
forge issue create --input '{"title":"...","kind":"task","labels":["p2"],"parent":"<epic id>","body":"..."}'
```

Kind: `task`, `bug`, `feature` or `epic`. Priority is one label of p0, p1, p2, p3, p4. File settled work and move on; fixes outside the current slice stay filed.

## Slice body: all six sections

1. **Behaviour**: the demoable, end-to-end user change, sized for one fresh context.
2. **Failing check**: the named check that fails before and passes after.
3. **Done boundary**: what is in. File anything beyond it.
4. **Touches / Needs / Owns**: files read, required from main, and written.
5. **Door**: reversible, or one-way (publish, force-push, prod-write, migration-apply, delete-branch, delete-worktree, merge-to-autodeploy, global-config).
6. **Size**: Aim at 400 changed lines; split above 800. If deletions exceed twice the additions, do not split and score light. Otherwise sum risk: churn over 518 lines +2, over 10 files +2, touches `core` or `blocks` +1. Bands: light 0-1, standard 2-3, heavy 4-5. Record estimates, points and band.

## Order

- Write a graph of demoable, one-context slices as Forge issues. Put prefactors and contract slices first; a need missing from main gets a contract slice.
- Join blocking edges with `forge issue dep --input '{"id":"<slice>","target":"<dep>","action":"add","expectRevision":<n>}'`; hold the claim and read the revision from `forge issue show` first.
- Each slice ships green alone. Wide refactors run expand, migrate in batches, then contract; each step is a slice and contract depends on every migration batch.
- Uncertain work goes last. For rename or removal, search the whole repo first and list every hit under Touches.

## When a slice is done

Re-plan: take the next ready slice (`forge issue ready --input '{}'`), re-slice, re-frame, or close superseded slices with `forge issue close --input '{"id":"<id>","withoutReceipt":"superseded by <id>"}'` while holding the claim. `withoutReceipt` records a written reason, not delivery evidence.
