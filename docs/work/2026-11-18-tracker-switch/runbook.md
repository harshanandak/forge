# Tracker switch runbook (step 4: the authority switch)

Nothing here runs now. This runbook starts only after step 3 passes. It makes the cloud project the one place that accepts issue writes, and it retires the local store as authority. Refs tracker-move-4-switch.

Evidence base: `origin/main` at `0ec6b194`. A citation `path:line` is rung 2 (read the line). Nothing below was run. The practice scripts named in Gaps are local and untracked, so their lines are not on main.

Decisions needed: three, listed at the end, each with a default.

Notation: `forge` means `node "$BIN"` (the installed build, per `docs/reference/cloud.md:28`). `$ORIGIN` is the Worker origin. `$PROJECT` is the step 3 cloud project name. `$LEDGER` is a private directory outside every repo (`mkdir -m 700 "$HOME/forge-move-ledger"`). Credentials never appear on a command line; admin calls use a private curl config file, as in `docs/reference/cloud.md:378`.

Two faults this runbook guards against everywhere authority moves: a write that lands while a snapshot is taken, and a comparison that checks issues but misses comments and links. Every snapshot below follows a fence, and every comparison covers issues, comments and links.

## How the code decides where authority lives

1. A checkout is cloud-bound when `.forge/cloud.json` exists and matches `.forge/project.json` (`src/assembly/cloud-binding.ts:32-47`). The file is committed and holds no secret (`.gitignore:24-28`). It is per working tree until it is merged.
2. A bound checkout sends sixteen `issue.*` operations and `lane.stop`, `lane.control` and `lane.resume` to the cloud, and opens no local store for them (`src/assembly/cloud-authority.ts:1-2`, `:75-95`). Other lane operations go to the device coordinator (`src/assembly/cloud-authority.ts:105`, `src/blocks/work/bound-lane-ops.ts:1`). Other work operations are refused by name (`src/assembly/cloud-authority.ts:106`).
3. A bound checkout refuses local project-state writes with `UNAVAILABLE` (`src/assembly/cloud-authority.ts:48-60`, wired at `src/assembly/index.ts:322`) and refuses `store reinit` with `INPUT_INVALID` (`src/assembly/cloud-authority.ts:102-103`, `docs/reference/cloud.md:178`).
4. The Worker admits one project for typed commands and login: `FORGE_CLOUD_PROJECT` (`cloud/src/worker.ts:90`, `:177`). Admin routes (`dump`, `status`, `revoke`) check only the admin token and reach any project name (`cloud/src/worker.ts:209-239`). So `dump` still answers for a project the Worker no longer admits. Raw lease routes with a device token also still reach it (`cloud/src/worker.ts:232-237`); they move leases, not issues.
5. The local store is per machine and not in git (`.gitignore:25`). Every git worktree of one repository shares one store, while `.forge/cloud.json` is per worktree (`src/assembly/index.ts:306-314`). Only this laptop has the real tracker.
6. An unbound checkout that still holds a saved credential for the project is refused with `INPUT_CONFLICT` (`src/assembly/cloud-binding.ts:48-56`). This matters for rollback.

The consequence of 1 and 5: after step 6 and before the step 9 merge, this laptop's bound worktree writes to the cloud while any unbound worktree or clone still writes to the one local store. Nothing in the code stops that. Only a store-level freeze does (Gap 1, forge-1561). This runbook requires it (P12).

## 1. Preconditions

Do not start until every item is true. Record each result in `$LEDGER`.

| #   | Precondition                          | How to check                                                                                                                                                  | Pass                                                                              |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P1  | Step 3 restore finished               | Step 3 report: every restore page accepted, final status read (`docs/reference/cloud.md:226`, `:278`)                                                         | Every page accepted; final `status` rows equal the expected rows                  |
| P2  | Six tables match                      | Paged dump readback compared with the expected image (`docs/reference/cloud.md:278-280`, `:282`). Save the readback pages: they are the cloud baseline for R3 | All six counts and digests match; stop-delta rows account for every extra row     |
| P3  | Left-behind inventory acknowledged    | The acknowledged digest in the bundle manifest equals the digest of `left-behind.json` (`docs/reference/cloud.md:272`)                                        | Digests equal; manifest `activation` is still the pre-activation warning (`:282`) |
| P4  | Step 3 source recorded (pre-freeze)   | Step 3 `source.json`: `sha256`, `eventHighWaterMark`, `records`, `at` (`docs/reference/cloud.md:261`), plus the family counts of that export                  | Saved in `$LEDGER`. Step 3 below takes a second baseline after the freeze         |
| P5  | Project holds no writes since restore | Admin `status` rows equal the step 3 final rows (`docs/reference/cloud.md:230`)                                                                               | Equal for all six tables                                                          |
| P6  | No live claims on the local store     | Left-behind report lists the live-lease count at backup time (`docs/reference/cloud.md:272`, `:284`). Leases are never imported (`:276`)                      | Zero at the step 3 snapshot, so the freeze needs no releases                      |
| P7  | Same build on every machine           | `forge --version --json` and `dist/build.json` (`docs/reference/cloud.md:24-25`)                                                                              | Identical `version`, `commit`, `dirty: false` on all machines                     |
| P8  | Worker secrets set                    | `DEVICE_LOGIN_HMAC_KEY` and `ADMIN_TOKEN` exist; owner vars set (`docs/reference/cloud.md:196`, `:357`)                                                       | Preflight passes (`docs/reference/cloud.md:369`)                                  |
| P9  | Id prefix agrees                      | Worker `FORGE_CLOUD_ID_PREFIX` equals the work block `idPrefix` in `.forge/config.yaml` (`docs/reference/cloud.md:339`)                                       | Equal strings                                                                     |
| P10 | Owner at a browser                    | One approval per machine login and one for lane resume (`docs/reference/cloud.md:28`, `:200`)                                                                 | Owner present for the whole run                                                   |
| P11 | Reverse path saved                    | Prior Worker version, a copy of the prior `wrangler.local.jsonc`, the immutable local backup (`docs/reference/cloud.md:284`, `:366`)                          | All three stored privately                                                        |
| P12 | Local freeze command shipped          | forge-1561 (Gap 1). It must make the local store refuse writes from every worktree and clone, bound or not                                                    | Shipped and tested. Do not run steps 2 to 12 without it                           |
| P13 | Export and restore tools shipped      | forge-1562 (Gap 2, export) and forge-1563 (Gap 3, restore and comparer). Step 3 and R3 name them                                                              | Shipped, or the owner accepts the manual procedure (decision C)                   |

Versions. Every machine must run one exact build that contains the cloud routing above. Main now carries `0.1.0-beta.9` (`package.json:3`, `docs/release.md:13`). I did not check which build any machine has. Treat that as unknown until P7 runs. Install the same archive on all machines with fresh prefixes, as in `docs/reference/cloud.md:14-25`. Never use a `forge` found on PATH.

## 2. The switch

Run the steps in order. Stop at the first failure and use the matching rollback in section 5.

Helper for steps 2, 7 and V8. It saves the issue list and every issue's comments and links. It reads only. `limit` has a maximum of 1000 (`src/blocks/work/schemas/ListItemsInput.json:19-24`), so `truncated` must be `false`.

```sh
snap() { mkdir -p "$1"; forge issue list --input '{"limit":1000}' > "$1/list.json"
  node -p 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).result;if(r.truncated)throw Error("truncated");r.items.map(i=>i.id).join(" ")' "$1/list.json" > "$1/ids.txt" || return 1
  for id in $(cat "$1/ids.txt"); do forge issue comments "$id" > "$1/$id.comments.json"; forge issue links "$id" > "$1/$id.links.json"; done; }
same() { node -e 'const f=require("fs"),[a,b]=process.argv.slice(1),j=p=>JSON.parse(f.readFileSync(p,"utf8")).result,k=(d,n)=>(n=="list"?j(d+"/list.json").items.map(i=>[i.id,i.title,i.status]):f.readdirSync(d).filter(x=>x.endsWith(n+".json")).sort().map(x=>[x,j(d+"/"+x).records.map(r=>r.value)]));let bad=0;for(const n of ["list",".comments",".links"])if(JSON.stringify(k(a,n))!==JSON.stringify(k(b,n))){bad=1;console.log("DIFF",n)}process.exit(bad)' "$1" "$2"; }
```

Expect the issue count from `snap` to equal the issue count in the step 3 manifest. `same` ignores `revision`, `updatedAt` and `updatedBy` because import restarts revisions at 1 (`docs/reference/cloud.md:270`). It compares issue id, title and status, and every comment and link value in order.

**Step 1. Save the reverse path.**

```sh
bun x wrangler deployments list --config wrangler.local.jsonc   # from cloud/; note the current version id
cp wrangler.local.jsonc wrangler.local.jsonc.before-switch      # private copy
```

Write the current `FORGE_CLOUD_PROJECT`, `FORGE_API_RESOURCE` and `FORGE_CLOUD_ID_PREFIX` values in `$LEDGER` (`docs/reference/cloud.md:334-339`).

**Step 2. Freeze local writes, then snapshot.** The freeze comes first. Every write after it is refused, so the snapshot cannot race a writer.

1. Run the forge-1561 freeze command on the local store (P12). Read back that a write from a second worktree is refused. Tell every session to stop.
2. Confirm zero live claims (P6). If one exists, release it with `forge issue release <id>` and write it in `$LEDGER`: it is a freeze write and step 3 must explain it.
3. Stop dispatch: `forge lane stop --input '{"all":true}'`. Stop needs no approval (`src/blocks/work/docs.json:101-104`). It stops lanes only, so it does not replace step 2.1. It is a local write, so do it before the export in step 3.
4. Save the local view: `snap "$LEDGER/local"`. Keep the directory private.

**Step 3. Final delta check between local and cloud.** There is no incremental import. A restore needs an empty project (`docs/reference/cloud.md:226`), so the test is whether the local content changed since the step 3 snapshot.

1. Take a new read-only export of the frozen store and write its `source.json` and family counts. This is the post-freeze baseline. It needs the forge-1562 export (Gap 2); until then use the manual script step 3 used.
2. Compare it with P4 by record, not only by counter. Every `forge/work` issue, comment and link record must have the same key, revision and `updatedAt`. Freeze writes touch claims, lane control and events, which are not imported content (`docs/reference/cloud.md:272`, `:276`).
3. `eventHighWaterMark` may be higher by the freeze writes you wrote down in step 2 and nothing else (`src/core/state/index.ts:2306-2318`). A rise you cannot explain is a write.
4. All equal: the step 3 project is current. Go on.
5. Any difference: stop. Repeat step 3 into a new project name and restart at P1. This needs the forge-1563 restore (Gap 3). Never write local changes into the existing project by hand.

Equal `sha256` is not required, because the image bytes may differ without a data change. I have not shown that they never do.

**Step 4. Confirm the cloud project is untouched.**

```sh
curl -sS --config '<admin-curl-config>' "$ORIGIN/p/$PROJECT/status"
```

Expect HTTP 200, `value.initialized: true`, and `value.dump.rows` equal to P5 for all six tables (`docs/reference/cloud.md:230`, `:406`). Then rerun the step 3 paged readback and comparison once (forge-1563 comparer, Gap 3). Expect six matching digests.

**Step 5. Admit the project on the Worker.** This is the cloud-side switch. Everything else is per machine.

1. In `wrangler.local.jsonc` set `FORGE_CLOUD_PROJECT` to `$PROJECT`, `FORGE_API_RESOURCE` to `$ORIGIN/p/$PROJECT`, and `FORGE_CLOUD_ID_PREFIX` to the P9 value (`docs/reference/cloud.md:334-339`).
2. From `cloud/` run the preflight, then deploy only if it passes (`docs/reference/cloud.md:369-375`):

```sh
node scripts/preflight.mjs --config wrangler.local.jsonc
bun x wrangler deploy --config wrangler.local.jsonc
```

3. Run the smoke checks that apply (`docs/reference/cloud.md:403-423`). Expect: `status` 200 with `initialized: true`; `POST /p/$PROJECT/command` with body `{}` and no token gives 401 `AUTH_REQUIRED`; the same call on any other project name gives 403 `AUTH_FORBIDDEN` (`cloud/src/worker.ts:90-103`).

Once this deploy lands, the Worker answers commands and login for `$PROJECT` only. Any earlier admitted project is cut off at once.

**Step 6. Bind machine A.** On this laptop, in the checkout. The freeze (step 2.1) is what keeps unbound worktrees from writing locally from here until step 9 merges.

1. Confirm `.forge/project.json` exists. Login never creates it (`docs/reference/cloud.md:208`).
2. Enable the cloud block in `.forge/config.yaml`: `blocks: { cloud: { source: { builtin: forge/cloud } } }` (`docs/reference/cloud.md:208`).
3. Log in. Set `FORGE_NO_BROWSER=1` if you want to open the link yourself:

```sh
forge auth login --origin "$ORIGIN" --project "$PROJECT"
```

4. The owner opens the printed `/device?code=XXXX-XXXX` link, ticks the confirmation box, approves, and signs in at Clerk (`docs/reference/cloud.md:210`).
5. Expect one stdout result with origin, project, device, token id and expiry, and no token (`docs/reference/cloud.md:212`). Write the token id in `$LEDGER`: rollback needs it. The binding `.forge/cloud.json` is written last, after the credential reads back (`:214`).

From this point every `issue.*` command on this checkout goes to the cloud.

**Step 7. Read-only comparison through the cloud.**

```sh
snap "$LEDGER/cloud" && same "$LEDGER/local" "$LEDGER/cloud" && echo MATCH
```

Expect `MATCH` and exit 0. `DIFF list`, `DIFF .comments` or `DIFF .links` names the table that differs; stop and use R2. Then `forge issue show <id>` for three ids you know, including a closed one and one with comments. Expect the same text as local.

**Step 8. First write and readback through the cloud.** This leaves one permanent proof issue; there is no delete.

```sh
forge issue create --input '{"title":"tracker switch proof","kind":"task"}'
```

Expect `"ok":true`, `"status":"OK"` and exit 0 (`src/assembly/cloud-authority.ts:314`, `docs/reference/cloud.md:49`). The new number must be above the issue number floor and never a reused one. The floor can sit above the highest live id when issues were deleted (`docs/reference/cloud.md:288-291`), so do not expect highest plus one. Compare with the floor in the restored `forge/work` records. Then:

```sh
forge issue show <proof-id>
forge issue claim <proof-id>
forge issue comment <proof-id> --body "switch proof from machine A"
forge issue close --input '{"id":"<proof-id>","withoutReceipt":"tracker switch proof"}'
```

Claim before close, because close needs the held lease (`docs/reference/cloud.md:158`). Expect each to return `"ok":true`.

**Step 9. Commit the binding.** Commit `.forge/cloud.json` (and `.forge/config.yaml` if changed) on a branch and merge it through the normal PR path. Other machines get the binding through git and nothing else. Write the merge commit sha in `$LEDGER`: R2 reverts it.

**Step 10. Bind machine B and every other host.** On each machine, and on each cloud agent host:

1. Install the same build (P7). Pull the commit from step 9.
2. Run `forge auth login`. No flags are needed once the binding exists (`docs/reference/cloud.md:208`). The agent starts it; the owner approves each code in the browser (`docs/reference/cloud.md:28`).
3. Run `forge issue show <proof-id>`. Expect the issue with the comment from step 8.
4. Write from B: `forge issue comment <proof-id> --body "switch proof from machine B"`. Expect `"ok":true`.

Never copy credentials between machines (`docs/reference/cloud.md:28`). A device credential lasts 30 days (`docs/reference/cloud.md:194`). Plan a re-login for every machine before day 30.

**Step 11. Lift the post-restore stop.** A restored project starts with an all-lanes stop, and a per-lane resume cannot lift it (`docs/reference/cloud.md:282`).

1. Run `forge lane resume --input '{"all":true}'` without approval. It returns an approval request.
2. The owner approves that request in the browser.
3. Run the same command again with `approval` set to the request id only. Cloud resume rejects `quote` and `source` (`src/assembly/cloud-authority.ts:137-144`).
4. Read it back: `forge lane control`. Expect no all-lanes stop.

**Step 12. Retire the local store.** Do not delete it. Keep `.forge/state.sqlite` and the immutable backup untouched, and frozen, until the retention period in `$LEDGER` ends (`docs/reference/cloud.md:274`, `:284`).

## 3. What stays local, and why

These families are declared local-only and were left behind on purpose (`docs/reference/cloud.md:272`): lane control, asks, clocks, events, merge state, participant membership, local attempt notes, bound-lane attachments, and autopilot state. Autopilot state is runtime state, so approvals for it are never imported as live.

Also local after the switch:

- **Event history.** The cloud keeps current values. Imported rows get fresh revision-1 events, and old history is not exported (`docs/reference/cloud.md:270`). Old history lives only in the retained backup.
- **Leases and request receipts.** New-project reset discards both. Old fences cannot authorize writes (`docs/reference/cloud.md:276`).
- **Device notes.** Use `memory.add` with `level=device` (`docs/reference/cloud.md:180`).
- **Project memory, decisions, check receipts, custom blocks.** These writes are refused on a bound project until generic state sync lands (`docs/reference/cloud.md:180`, `src/assembly/cloud-authority.ts:54-59`).
- **Operations the cloud does not serve.** `issue.board`, `issue.call`, `issue.checkpoint`, `issue.resume`, `issue.events`, `issue.tree`, `issue.lint`, `issue.invite`, `issue.join`, `issue.leave` and `attempt.*` are refused by name on a bound project (`src/assembly/cloud-authority.ts:75-107`, declared at `src/blocks/work/docs.json:245-405`). Plan daily work without them.
- **`issue.close` with a local receipt.** Use `--pr` or `withoutReceipt` (`docs/reference/cloud.md:158`, `:176`).

## 4. Verification

The cloud is the only authority when every check below passes. Run them after step 11.

| #   | Claim                                               | Command                                                                                      | Expected                                                                                                                                                               |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | A write on A is read on B                           | A: `forge issue comment <proof-id> --body "v1"`; B: `forge issue comments <proof-id>`        | B lists the comment from A, in append order (`docs/reference/cloud.md:166`)                                                                                            |
| V2  | A write on B is read on A                           | Reverse of V1                                                                                | A lists the comment from B                                                                                                                                             |
| V3  | A bound checkout writes no issue to the local store | Rerun the read-only local export from step 3 and compare issue, comment and link records     | Records equal the step 3 post-freeze baseline; `eventHighWaterMark` unchanged. Failure branch below                                                                    |
| V4  | Local project-state writes are refused              | `forge memory add --input '{"text":"x","level":"project","scope":"switch","tags":["fact"]}'` | `ok:false`, code `UNAVAILABLE`, exit 1, message starts "This project is cloud-bound" (`src/assembly/cloud-authority.ts:54-56`)                                         |
| V5  | Store recovery is refused                           | `forge store reinit --dry-run`                                                               | `INPUT_INVALID`, exit 6, "store.reinit is not served by the cloud authority of a cloud-bound project yet." (`docs/reference/cloud.md:178`)                             |
| V6  | Unsupported ops refuse, not fall back to local      | `forge issue tree <id>`                                                                      | `INPUT_INVALID`, exit 6, "... is not served by the cloud authority of a cloud-bound project yet." (`src/assembly/cloud-authority.ts:41-45`)                            |
| V7  | The Worker admits only `$PROJECT`                   | `POST $ORIGIN/p/<any-other-name>/command` with body `{}`                                     | 403 `AUTH_FORBIDDEN` (`cloud/src/worker.ts:90-97`)                                                                                                                     |
| V8  | Cloud and ledger agree                              | Admin `GET status`; then `snap "$LEDGER/cloud2"`                                             | Rows equal step 3 rows plus exactly the writes from steps 8, 10, V1 and V2. `same "$LEDGER/cloud" "$LEDGER/cloud2"` differs only by those comments and the proof issue |
| V9  | A checkout with no credential fails closed          | On a bound checkout with no saved credential run `forge issue list`                          | Expected: a refusal from the cloud client, not a local answer. The route never falls back to the local store (`src/assembly/cloud-authority.ts:277-281`, `:291-299`)   |

**V3 failure branch.** Records or the counter moved after the frozen export, so a local write landed: an unbound worktree or clone, or a session that ignored the stop. Stop at once. Do not resume lanes. Find the write by comparing the new export with the post-freeze baseline by key and revision. Then choose:

- **Few writes (default).** Replay each into the cloud with the cloud-served commands (`issue create`, `comment`, `link`, `update`, `close`), record each in `$LEDGER`, and refreeze. Say in the ledger that the local store is no longer a faithful backup.
- **Many writes, or any you cannot explain.** Roll back (R2, R1, R0), find the writer, and redo from step 3 into a new project name.

V4 and V5 prove the local store is refused for project state in a bound checkout. They do not prove it is impossible: a worktree or clone without `.forge/cloud.json` is unbound and writes locally with no warning (`src/assembly/cloud-binding.ts:48-52`). `git status` does not help, because the file is allowed by `.gitignore` and shows as an untracked file, not as a fault. List every worktree with `git worktree list` and check each for `.forge/cloud.json`. The real fence is the forge-1561 freeze (P12), which makes the store itself refuse.

## 5. Rollback

Never run two writable authorities (`docs/reference/cloud.md:284`). Pick the row that matches how far the switch got. R1 comes before any cloud dump in R3 because it is the cloud-side write fence.

**R0. Before step 5 (Worker not changed).** Nothing left this laptop. Lift the local freeze, run `forge lane resume --input '{"all":true}'` on the local project (owner approves), and tell sessions to continue. The step 3 cloud project stays. There is no project delete (Gap 7).

**R1. Un-admit `$PROJECT` on the Worker.** Put the old vars back. Redeploy the saved copy:

```sh
cp wrangler.local.jsonc.before-switch wrangler.local.jsonc
node scripts/preflight.mjs --config wrangler.local.jsonc
bun x wrangler deploy --config wrangler.local.jsonc
```

Read back with the V7 call against `$PROJECT`: expect 403 `AUTH_FORBIDDEN`. From here no typed command, so no issue write, reaches `$PROJECT` (`cloud/src/worker.ts:90-97`). An alternative is `bun x wrangler rollback <version-id> --config wrangler.local.jsonc` with the id from step 1. It swaps code only and does not undo stored data (`docs/reference/cloud.md:467`). I did not check whether it also restores var values, so prefer the redeploy. Then do R0.

**R2. After binding a machine, before any cloud write (before step 8).** On each bound machine, in this order:

1. Revoke the device token by the id in `$LEDGER` with the admin `revoke` route (`docs/reference/cloud.md:135`). Do this first, so a copied credential dies even if the next steps fail.
2. Remove the saved credential for this project. There is no logout command yet (Gap 6, forge-1566). When it ships, use `forge auth logout`. Until then, find out whether `~/.forge/cloud/credentials.json` holds only this project's entry, without printing tokens, using the owner's local helper `node <agent-config>/scripts/safe-inspect.js summary ~/.forge/cloud/credentials.json`. If the summary shows one entry and it is this origin and project, delete the file. If it shows others, stop and ask the owner. A hand edit risks `ACCOUNT_INTEGRITY` (`docs/reference/cloud.md:214`). Leaving the credential in place keeps the checkout refused with `INPUT_CONFLICT` (`src/assembly/cloud-binding.ts:48-56`).
3. Delete the working-tree `.forge/cloud.json`.
4. If step 9 merged, open a PR that reverts the binding commit from `$LEDGER` (`git revert <sha>`) and merge it. Until it merges, every machine that pulls gets a binding and a refusal. Machines that already pulled must repeat 1 to 3.
5. Do R1, then R0. Lost: nothing. Local still holds every record.

**R3. After cloud writes (step 8 or later).** The cloud now holds changes the local store lacks. Lost if you do nothing: every issue, comment, link, claim and close made in the cloud.

1. Tell sessions to stop. `forge lane stop --input '{"all":true}'` stops dispatch only and does not fence issue writes.
2. Do R1 first. It stops typed commands reaching `$PROJECT`. The admin `dump` still answers for an unadmitted project (`cloud/src/worker.ts:209-239`), so the dump after R1 is the final state.
3. Read admin `status` rows. Take the paged dump (`docs/reference/cloud.md:224-225`) and read `status` again. Rows must be equal, and a write during the dump is refused as `DUMP_CHANGED` (`docs/reference/cloud.md:225`). Keep the dump private.
4. Find cloud-only work by comparing the dump with the step 3 paged readback (the P2 baseline), key by key and revision. Cover every `state_records` row, including comment and link records, not only issues. The local `snap` view holds no cloud-side changes, so it cannot be the baseline here. Writes from step 8 onward are expected. The comparer is forge-1563 (Gap 3).
5. Do R2 on every machine, including the revert PR, then R0.
6. Replay the cloud-only work into the local store by hand with `forge issue create`, `comment`, `link`, `update` and `close`. There is no cloud-to-local import (Gap 8, forge-1568). New issues take the next local numbers, which equal the cloud numbers only if you replay in order and the local store made none in between. Check each id.
7. After replay, run `snap "$LEDGER/replayed"` and `same` it against a snap of the cloud dump contents. Expect `MATCH` for ids, titles, comments and links.
8. Lost even after replay: cloud event history, lease generations, and request receipts (`docs/reference/cloud.md:276`, `:144`).

If cloud writes were few, prefer to keep the cloud and repair forward. Rollback after heavy cloud use is manual and error prone.

## 6. Gaps

Each row is a place where the code has no command for a step, or differs from the plan. I fixed none of them. The issue column holds the filed id.

| #   | Issue      | Suggested issue title                                                                | Evidence                                                                                                                                                                                                                                                                  |
| --- | ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | forge-1561 | Add a command that freezes or retires the local tracker store                        | The only core store operations are `store.reinit` and `project.init` (`src/core/state/operations.ts:4`, `:13`). `lane.stop` stops lanes only (`src/blocks/work/docs.json:101-104`). An unbound worktree still writes locally (`src/assembly/cloud-binding.ts:48-52`).     |
| 2   | forge-1562 | Ship a read-only `forge store export` that writes a backup and `source.json`         | Only `StateOwner.export()` exists in src (`src/core/state/index.ts:2306`). The practice export is a local untracked script with hardcoded paths (`.overseer/tools/practice-export.mjs:5-13`, `:21-28`).                                                                   |
| 3   | forge-1563 | Ship a tool that restores converted pages into a cloud project and compares readback | The only sender is a local untracked script with a hardcoded Worker, project pattern and acknowledgement (`.overseer/tools/practice-move.mjs:7`, `:14`, `:21`). `tools/import-current.ts` converts only (`tools/import-current.ts:283-325`).                              |
| 4   | forge-1564 | Support or document an incremental local-to-cloud delta for the tracker move         | Restore needs an empty project (`docs/reference/cloud.md:226`). Any local write after the snapshot forces a new project and a full re-import (step 3 of this runbook).                                                                                                    |
| 5   | forge-1565 | Admit a cloud project without redeploying the Worker                                 | The Worker serves one project, set by a var (`cloud/src/worker.ts:90`, `:177`; `docs/reference/cloud.md:338`). Switching means a redeploy that cuts off the old project at once.                                                                                          |
| 6   | forge-1566 | Add `forge auth logout` (unbind) that removes binding and credential together        | Binding is create-only (`src/assembly/cloud-profile.ts:460-482`). No logout or unbind appears in `src/`. A credential with no binding is refused (`src/assembly/cloud-binding.ts:48-56`).                                                                                 |
| 7   | forge-1567 | Add an admin project delete for abandoned cloud projects                             | Only whole-Worker delete exists (`docs/reference/cloud.md:507`). The practice run kept its data for this reason (`.overseer/tools/practice-move.mjs:56`).                                                                                                                 |
| 8   | forge-1568 | Add a cloud-to-local export so a rollback can carry back cloud writes                | `tools/import-current.ts:283-325` goes one way. Cloud dump is admin JSON only (`docs/reference/cloud.md:137`, `:224`).                                                                                                                                                    |
| 9   | forge-1569 | Fix the cloud reference: lanes are served for bound projects                         | `docs/reference/cloud.md:176` says lanes are not served. Code routes `lane.stop`, `lane.control`, `lane.resume` to the cloud and other lane operations to a coordinator (`src/assembly/cloud-authority.ts:92-95`, `:105`).                                                |
| 10  | forge-1570 | Align `lane.resume` docs with the cloud approval shape                               | `src/blocks/work/docs.json:114` says approval takes `{request, quote, source}`. Cloud accepts the request id only (`src/assembly/cloud-authority.ts:137-144`).                                                                                                            |
| 11  | forge-1571 | Serve or retire the remaining work operations for cloud-bound projects               | Refused by name: `issue.board`, `call`, `checkpoint`, `resume`, `events`, `tree`, `lint`, `invite`, `join`, `leave`, `attempt.*` (`src/assembly/cloud-authority.ts:75-107`; `src/blocks/work/docs.json:245-405`). Lanes track forge-1248 (`docs/reference/cloud.md:176`). |
| 12  | forge-1572 | Add a command that lists live leases before a move                                   | I found no operation that lists live leases. Only `issue.stale` (expired, unreleased) and the left-behind count exist (`src/blocks/work/docs.json:258`, `docs/reference/cloud.md:272`). Absence claim from a name search.                                                 |
| 13  | forge-1573 | Decide whether tracker history must move with current state                          | Imported events are fresh revision-1 pairs, not history (`docs/reference/cloud.md:270`). `issue.events` is not served on a bound project (`src/blocks/work/docs.json:314`).                                                                                               |
| 14  | forge-1574 | Fix the stale "Forge 0.0.1" text in the cloud-bound write refusal                    | The refusal message names version `0.0.1` while main is `0.1.0-beta.9` (`src/assembly/cloud-authority.ts:56`, `package.json:3`).                                                                                                                                          |
| 15  | forge-1575 | Prove whether the restore-time stop blocks `issue.*` writes                          | `docs/reference/cloud.md:49` and `:282` say the stop gates dispatch. I found no statement about issue writes. Step 8 writes before step 11 resumes; the first write tests this.                                                                                           |

Existing issue, not new: device credentials last 30 days and refresh tokens are deferred (`docs/reference/cloud.md:194`, `docs/work/2026-11-10-teams-phase1/plan.md:1`, forge-1125).

## Not verified

- Which build each machine runs now.
- Whether `wrangler rollback` restores var values.
- Whether equal export `sha256` is guaranteed for equal data.
- Whether the all-lanes stop blocks issue writes (Gap 15).
- Whether `forge issue list`, `comments` and `links` print only the JSON envelope on stdout, which `snap` and `same` assume (the rehearsal script reads the first line that starts with `{`).
- Whether a local claim release or lane stop leaves issue records unchanged, which step 3 assumes.
- Anything about the live Worker or the real tracker. No command in this runbook has been run.

## Decisions needed

- **A. Delta policy.** If step 3 finds the local store changed, redo the full import into a new project (default), or add an incremental tool first.
- **B. Retention.** Keep the local store and backup unchanged for 30 days after the switch (default), or a different period.
- **C. Gap order.** Ship Gaps 1, 2, 3 and 6 (forge-1561, forge-1562, forge-1563, forge-1566) before the switch (default). This runbook assumes it: P12 and P13 block the run. The alternative is the manual procedures above, with the race in step 6 left open.
