# Tracker switch runbook (step 4: the authority switch)

Decisions needed: none for this rewrite. Execution is blocked by P12 to P14 below.
This procedure starts from the cloud copy made by tracker-move-3-real. It authorizes no move now.
The local store remains authority until the switch passes Verification.
Refs forge-1577; replaces the parked runbook at `14880f2a` (closed PR 625).

Evidence: source read on `origin/main` at `31536e91` is rung 2, not execution proof.
PRs 626 (logout), 652 (atomic freeze) and 653 (delta) were open when read on 2026-11-18.
Steps depending on them say so. Require their final implementations in the pinned build.
The 11:13Z rehearsal report (forge-1466 comment 13) reports rung 5 six-table readback and rung 4 local checks.
Its counts and digests describe that practice only. This switch has not been run.

Notation: `forge` is `node <pinned-build>/dist/bin/forge.js`, never an arbitrary PATH command.
Run the pinned Bun with `bun <tool.ts>` for offline tools. Commands below use PowerShell variables.
Use PowerShell 7.3+ and invoke the pinned Node executable directly, never a `.cmd`/`.bat` shim. First run `if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Use PowerShell 7.3 or later' }`, then `$PSNativeCommandArgumentPassing = 'Standard'`; this preserves quotes in native arguments ([PowerShell argument handling](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-7.5#passing-arguments-that-contain-quote-characters)).
`$Ledger` is `E:/forge-move-ledger/<stamp>/`, private and outside every repo.
`$Project`, `$Origin`, the S7 snapshot path and all expected values come from step 3's `run.json` there.
`$Bundle` holds retained or regenerated converter pages; `$Dump` holds a complete paged cloud dump.
`$DeltaBackup` and `$DeltaManifest` name the retained upgraded converter input and its `source.json`.
Keep the immutable raw export separately. Step 3.1 pins a frozen S7 rollback baseline; retain P4's earlier copy too. Never substitute either raw file for `$DeltaBackup`.
Admin helpers read credentials in-process, print no secret, follow no redirect and check the exact target before every call.
Use the reviewed helpers for status and revoke and the R3.3 capture command for paged dumps.
Never put bearer bytes on a command line, print a credential file, or copy credentials between machines.

The binding identity is the UUID in `.forge/project.json`, not the cloud project name.
`.forge/cloud.json` travels in git; each machine's credential does not.
Bound issue commands route to cloud; unbound worktrees sharing the store need the local freeze.
A lane stop stops dispatch, not issue writes. A Worker admission change fences typed commands, not admin routes or raw leases.

Round-1 findings also checked on `origin/main` at `5de255a3`. Source pointers on the cited main: `src/assembly/store-export.ts`, `tools/import-current.ts`,
`tools/restore-cloud.ts`, `tools/cloud-to-local-delta.ts`, `src/blocks/work/entry.cts` (`board`, `laneFreeze`, `laneUnfreeze`),
`src/blocks/work/docs.json` (`issue.board`) and `src/assembly/cloud-authority.ts`.
Pending behaviour comes from the diffs of PRs 626, 652 and 653, not an assumption that they merged.
Asset: every local or cloud write after the freeze. Threat: rollback loses a write, or a correct import/replay fails comparison.
Mitigation: retain both authorities' deltas, name every replay or accepted loss, and compare with explicit field rules.

## Preconditions

Do not execute step 1 until every row passes. Record evidence and paths in `run.json`.

| Check                      | Expected value and source                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 Copy complete           | Step 3 restore report says `restored:true`, `match:true`; every page accepted for the exact `$Project`.                                                                                                                                                                         |
| P2 Six tables              | Saved restore readback matches expected rows and SHA-256 for all six tables listed in Verification, including generated stop rows. Retain the readback baseline.                                                                                                                |
| P3 Acknowledgement         | Bundle manifest's left-behind SHA-256 equals this run's `left-behind.json` hash. Record scope and approver; practice acknowledgement cannot authorize the real move.                                                                                                            |
| P4 Source                  | Save raw S7 `backup.sqlite`, `source.json`, `export-info.json`, record-family counts and source/config before/after hashes from step 3. Retain upgraded input too, per step 3 below.                                                                                            |
| P5 No cloud writes         | Admin status for `$Project` equals all six final row counts in step 3 `run.json`. Also compare a fresh six-table dump with the saved readback; equal counts alone miss updates.                                                                                                 |
| P6 Claims drained          | Step 3 snapshot has zero live leases, but time has passed. Re-enumerate `issue.board` at step 2.1; release own claims, obtain releases from other holders or wait for expiry. A past zero never means no releases now.                                                          |
| P7 One build               | Every machine reports identical version and commit with `dirty:false` using the pinned build's version output/build manifest. Include final dependency PRs.                                                                                                                     |
| P8 Worker ready            | Reviewed preflight passes for the target origin, owner, login HMAC and admin-token presence. Record existence/results, never secret values.                                                                                                                                     |
| P9 Identity/prefix         | Checked Worker `FORGE_CLOUD_ID_PREFIX` equals the configured work prefix; binding UUID equals project UUID. Record non-secret values privately.                                                                                                                                 |
| P10 Owner present          | Owner can approve login in the browser and reply in chat to cloud resume and R0's separate local unfreeze/resume requests. Logout practice uses a hand-built sandbox binding, without the owner's browser.                                                                      |
| P11 Reverse path           | Save S7 snapshot/hash, prior Worker version and private prior vars/config copy. Inventory every checkout and machine, installed build and token id from login results.                                                                                                          |
| P12 Freeze                 | Require PR 652 merged and atomic refusal practised on the pinned build. PR 627's freeze alone is insufficient. Include every clone/store that can accept local writes.                                                                                                          |
| P13 Offline/restore/logout | Export, converter and restore tools below available; PR 626 merged. Practise snapshot restore with private ACLs, preserved freeze and readback. PR 653 is open with the delta fix, pending its merge gate; require its implementation and provenance checks.                    |
| P14 Single writer          | A practised replay path must let exactly one designated writer write while the local freeze remains set. Current `lane.unfreeze` is not that path. No single-writer tool is specified here; block the switch until this dependency has an exact command, refusals and evidence. |

P13/P14 are execution dependencies, not permission to improvise a restore or temporarily lift the freeze.
Log the exact shipped restore/replay procedure and refusal evidence in the execution ledger before declaring them passed.

## The switch

Stop on the first refusal or mismatch. Keep the freeze from step 2.3 through success or the full rollback.
A successful switch leaves local writes frozen throughout retention; it never runs R0.

**Step 1. Save the reverse path.**
Save the current Worker deployment version and a private copy of its vars/config with the reviewed operator helper.
Record prior `FORGE_CLOUD_PROJECT`, `FORGE_API_RESOURCE` and `FORGE_CLOUD_ID_PREFIX` without secrets.
Check S7's hash against step 3 `source.json`. Record the step 9 binding merge commit when it exists.
Do not run a deploy, login or switch merely to write or review this document.

**Step 2. Drain writers, freeze, then snapshot.** Depends on PR 652.

1. Tell all sessions to stop. On an unbound checkout run `forge issue board --input '{}'`, passing each returned `cursor` back until `truncated:false`. Save every row's id, holder, `leaseState`, `expiresAt`. Open issues may have live or stale leases. Rows have no acquired time or lease generation. `CURSOR_STALE` means restart the listing. `forge issue release <id>` releases only this session's lease; another holder must release theirs or reach expiry. Recheck all pages for zero live issue leases. Lane/attempt coverage is unverified; resolve that separately before P6 passes.
2. Run `forge lane stop --input '{"all":true}'` locally before freezing. Record this dispatch-stop write and every claim release in the ledger. These are preparation writes; the freeze itself is another recorded write.
3. Run `forge lane freeze --input '{}'` on every local authority store. Expect `frozen:true` and `at`. It writes `autopilot:global` and its event when first setting the freeze; a repeat preserves the time. Save exact before/after records and event increments. From a second unbound worktree attempt an agreed issue update: expect `UNAVAILABLE`, exit 1, with no changed record/event. A racing write may instead get `REVISION_CONFLICT`; verify no mutation and retry the refusal check. Unexpected success stops the switch.
4. Capture the frozen read-only local view and export in step 3. Save every issue, including closed issues, every comment and link, following pagination. Require completed pagination, with no result left truncated. Keep all artifacts private. Step 3.1 pins the frozen S7 baseline used for later breach detection and rollback.

Do not release or renew a lease, stop/resume local lanes, or lift the freeze after 2.3.
PR 652 makes those mutation paths refuse while frozen. Read-only board/list/export remain checks, not permission to write.

**Step 3. Check the final delta and keep both backup forms.**

1. Set `$ExportInput = @{out=(Read-Host 'Fresh private ledger folder')} | ConvertTo-Json -Compress -Depth 5`, then run `forge store export --input $ExportInput`. Hash the source database and project config before and after with the reviewed read-only helper; both hashes must match. Export uses a read-only store and writes `backup.sqlite`, `source.json`, `export-info.json` only in the destination. A nonempty destination is `INPUT_CONFLICT`; missing store is `UNAVAILABLE`; invalid input is `INPUT_INVALID`. Stop on any refusal or hash mismatch. Pin this export as the frozen S7 rollback baseline with its hash, records and event high-water mark in `run.json`; retain P4's pre-freeze copy separately.
2. Compare frozen export to P4 by key, value, revision and `updatedAt` for all imported work records, including issues, comments, links, dependencies and allocation floors. Only recorded preparation writes from 2.1, 2.2 and the freeze write in 2.3 may explain changed local runtime/lease/event records or high-water increments. Unexplained movement stops the switch. Do not assume byte-identical SQLite exports for equal data.
3. Any imported-content difference requires a fresh full copy into a new project, with a new acknowledgement and all six readbacks. An empty-project restore is not incremental import. Restart P1; keep the local freeze set throughout.
4. Set `$S7` to step 3.1's frozen export folder and `$Prepared` to `"$Ledger/retained-input"`, which must be new. Use owner-only permissions on S7 and its files and on `$Ledger`. From the pinned source checkout run `bun tools/prepare-tracker-input.ts --backup "$S7/backup.sqlite" --manifest "$S7/source.json" --out $Prepared`. Require exit 0 and `"$Prepared/source.json"`. Record both hashes and reconcile the applied migrations, schema and table changes in `"$Prepared/preparation.json"`. Check the reported commit against P7 and require `dirty:false`. Retain the raw export and preparation outputs privately. Set `$DeltaBackup` to `"$Prepared/backup.sqlite"` and `$DeltaManifest` to `"$Prepared/source.json"`.
5. Regenerate a bundle if needed, using two fresh output directories. The converter's own internal migrated scratch is deleted on exit; it is not the retained upgraded backup. Run:

```powershell
bun tools/import-current.ts --backup $DeltaBackup --manifest $DeltaManifest --out "$Ledger/bundle-first"
```

Expect `INPUT_INVALID`, exit 6, `Offline import refused; no verified complete bundle`, with `left-behind.json` but no verified manifest.
Only this acknowledgement refusal is expected. Read the inventory and live-lease keys; do not mistake another failure for the gate.
Require zero live leases and the frozen-export family set in What stays local, including exactly 1 `forge/work autopilot-global:*` record. Hash this run's file and obtain acknowledgement for this inventory:

```powershell
$Ack = (Get-FileHash -Algorithm SHA256 -LiteralPath "$Ledger/bundle-first/left-behind.json").Hash.ToLowerInvariant()
```

Once the acknowledgement is recorded, run the converter a second time into a fresh directory:

```powershell
bun tools/import-current.ts --backup $DeltaBackup --manifest $DeltaManifest --out "$Ledger/bundle" --acknowledge-left-behind $Ack
```

Require success and manifest left-behind digest equal to `$Ack`. Save digest, scope and approver in `run.json`.
A mismatch or unexpected family stops the copy. Do not reuse the rehearsal digest or claim its scope covers this run.

6. For a replacement copy, check exact target `forge-tracker-<stamp>` and admin `initialized:false` before any cloud call. Use the reviewed guarded wrapper around `tools/restore-cloud.ts` with `--pages`, `--worker`, `--project`, `--token-env <variable-name>` and `--report`. The variable holds a credential loaded in-process, never a literal argument. Require `restored:true`, `match:true` and all six digest matches, not only counts. `TARGET_NOT_EMPTY`, `DIGEST_MISMATCH`, page/order/response refusals or any partial restore stop the run. Never retry restore into the same project; retain its failure report and use a new project only after resolving the cause.

7. Capture all pages independently with R3.3 while cloud writes remain withheld, then match all six restore digests. Run the R3.4 delta tool against the upgraded input and save its raw report. Compare each allocation key/value with the converter-derived floors in the bundle: an identical derived floor is an import artifact, not a cloud write. Require zero unexplained new/changed/absent entries after accounting for those exact floors and repairs in `same-import`; raw 0/0/0 is not required. Save the by-key derived-floor baseline and raw delta for R3, where only departures from those values count as later floor changes. Retain both raw backups, upgraded input/manifest, bundle pages/manifest, repairs by key, left-behind inventory, restore/readback/delta reports and `run.json` privately and read-only; these pages are now required comparison evidence.

**Step 4. Check capacity and target.**
Read admin status and usage for exactly `$Project`. Compare all six counts/digests with step 3's final baseline and usage with configured Worker limits.
Keep the restored all-lanes stop. An unexplained delta, missing report or limit refusal stops the switch.

**Step 5. Admit the new project.**
The authorized operator sets `FORGE_CLOUD_PROJECT=$Project`, preserves the saved resource/prefix values, runs `cloud/scripts/preflight.mjs` and deploys with the private `wrangler.local.jsonc`.
Read status for `$Project`; typed command on a different project must return 403 `AUTH_FORBIDDEN`.
An unauthenticated command on `$Project` must return 401 `AUTH_REQUIRED`. On failure use R1, then the applicable rollback; do not unfreeze.

**Step 6. Bind machine A.**
Confirm project UUID/prefix from P9. Enable the cloud block through the approved config change.
Run `forge auth login --origin $Origin --project $Project`; while the owner has not approved, login polls `authorization_pending` and saves no binding. The owner opens the printed verification link and approves this device in the browser; the same call then finishes without an `approval` argument. `LOGIN_DENIED`/`LOGIN_EXPIRED` stops the step; after expiry obtain a new challenge with the same command and ask again.
Save returned origin, project, device, token id and expiry in the ledger; never the token.
Login writes the binding last after credential readback. Verify binding UUID/origin/project against P9 and `run.json`.
The freeze from step 2.3 still fences every unbound worktree. Any login/integrity refusal stops the switch.

**Step 7. Compare through cloud.**
Read every issue, comment and link through the bound CLI, including closed issues and all pages.
Use `same-import` in Verification against the frozen local view plus converter repairs, not the raw local view. Save a fresh cloud dump for persistent fields hidden by the CLI; compare every issue/comment/link key and value.
Check known open and closed issues and one with comments using `forge issue show <id>`.
Mismatch before cloud writes takes R2; mismatch after any write takes R3.

**Step 8. First cloud write and readback.**
Create one permanent proof issue. Set `$ProofInput = @{title=(Read-Host 'Proof issue title'); kind='task'} | ConvertTo-Json -Compress -Depth 5` and enter `tracker switch proof`, then run `forge issue create --input $ProofInput`.
Require `ok:true`, read it back, and compare its number with the restored allocation floor; never require highest-live-id plus one.
Claim it, comment `switch proof from machine A`, then close using an explicit `withoutReceipt` reason.
Read back each result; record the proof id and every write/lease effect in the ledger. Any refusal now takes R3.

**Step 9. Commit the binding.**
Commit `.forge/cloud.json` and the approved cloud-block config change through a normal PR.
Record the merged binding commit. R3 step 5 reverts that commit; R2 alone does not undo git history.
Keep the local freeze while the binding reaches every worktree and host. Failure after step 8 takes R3.

**Step 10. Bind every other machine and host.**
Pull step 9's commit, install P7's build, and run `forge auth login` on each device. Follow step 6's pending/owner-browser-approval flow; retry an expired challenge with exactly `forge auth login`, obtaining a new owner decision.
Each host reads the proof issue and writes a uniquely labelled comment; A reads every comment back.
Inventory every checkout, UUID, origin, project and token id. No copied credentials. Plan re-login before the 30-day expiry.

**Step 11. Lift the cloud dispatch stop.**
Run `forge lane resume --input '{"all":true}'`. Expect `APPROVAL_REQUIRED` with the request, scope and UTC expiry. The cloud dispatch stop stays set.
Show `result.ask` in chat and wait for a clear affirmative reply within 10 minutes. Silence, refusal or ambiguity leaves the stop set.
Retry `forge lane resume --input '{"all":true,"approval":{"request":"<result.request>","quote":"<exact owner reply>","source":{"harness":"<harness>","thread":"<thread>"}}}'`.
Require success, then read `forge lane control` and require no all-lanes stop. This changes no local freeze.
If the request expires or the stop changes, obtain a fresh request and a fresh owner reply. To reconcile a lost completion response, retry the same completion id and input, then read current lane control.

**Step 12. Verify and retain.**
Run every Verification row. Retain the frozen store and both immutable backup forms for 30 days by default.
No deletion, local unfreeze or local resume completes a successful switch.

## What stays local

The 11:13Z practice inventory had these families before this runbook's freeze:
`forge/check runs/*`; `forge/core-project identity`; `forge/memory meta/*`, `note/*`, `transfer/*`;
`forge/work autopilot-ask:*`, `autopilot-clock:*`, `autopilot-event:*`.
For a bundle regenerated from the frozen export, require that set plus `forge/work autopilot-global:*`, with count exactly 1.
Step 2.3 writes the freeze into the singleton `autopilot:global`, creating it if absent or updating the existing record.
The converter leaves that record local and reports it as `autopilot-global:*`; the namespace/key primary key permits only 1.
Other family counts are not fixed. That practice had 1766 left behind and 2 live leases; real-copy acceptance requires zero live leases.
Any family outside the applicable expected set needs review and a new acknowledgement before conversion proceeds.

The backup also retains old event history, local runtime state, old leases, requests and receipts.
Import creates current values with fresh revision-1 events, not the old history. Old fences cannot authorize cloud writes.
Device memory stays on device. Generic project memory/decisions/check-receipt writes are refused while cloud-bound.
`issue.board`, call/checkpoint/resume/events/tree/lint/invite/join/leave and `attempt.*` are not cloud-served.
Bound lane operations have their own coordinator; do not infer that all work commands fall back locally.

## Verification

`same-import` is a read-only comparison of frozen export and cloud `state_records` by namespace/key and canonical value.
Enumerate all issues, dependencies, comments and links, including closed issues; reject unfinished pages, duplicates and missing keys. Preserve ids and append order.
Build expected cloud values from the frozen export plus the converter's exact repairs, checked against retained bundle pages.
For each closed issue missing both `receipt` and `withoutReceipt`, record its key and before/after `withoutReceipt:"Imported: closed before Forge required close evidence"`.
Reconcile the number of repaired current records and historical updates with manifest `repaired.records`/`historicalUpdates`; the rehearsal's 154 is not a fixed target. Any other value change fails.
Ignore only envelope `revision`, `updatedAt`, `updatedBy` because import resets them. No persistent value field, including `createdAt`, is ignored.
CLI `revision`/`updatedAt` project the envelope; `lease` is a live view, not an issue value. Check leases separately; do not compare them as imported content.

`replay-check` is a per-record checklist against frozen S7 plus both authorities' reconciled changes, minus only named owner-accepted losses.
Retain a row for every source event and final key, its source/expected/actual values, replay command/result, field exceptions and acceptance. Check all persistent value fields, not a three-field issue summary.

| Record or field                  | Exact replay comparison rule                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untouched S7 record              | Compare its raw envelope and entire value exactly against frozen S7; do not add converter repairs to rollback's raw baseline.                                                                                                                                                                           |
| New issue replayed with create   | Only value `createdAt` is automatically regenerated by create; record old/new times by key and obtain acceptance. Keep title/body/kind/status/labels/dependencies/parent/close evidence and all other value fields exact.                                                                               |
| Mutated/replayed record envelope | Only `revision`, `updatedAt`, `updatedBy` are regenerated by StateOwner; record old/new values by key. Existing issue `createdAt` stays exact. Comments/links add no generated value timestamps.                                                                                                        |
| Generated identity/defaults      | Issue id/prefix and numbered comment/link keys are allocated, not caller-set. Never drop them from comparison: require exact ids, references, prefix, keys and append order, or a named owner-approved remap/loss for a collision. Defaults such as labels/dependsOn/status must match intended values. |
| Unrepresentable fields/actions   | Deletions, floor advances, receipts, hidden `closeReason` or any value the CLI cannot reproduce remain discrepancies until explicitly accepted as lost by key/field. Never expand the ignored-field list.                                                                                               |
| Runtime/history                  | Event sequence/time/actor/requestId, leases, request receipts and command receipts are not replayed; enumerate affected entries/keys and obtain loss acceptance. Exclude them only from the value checklist, not from coverage.                                                                         |

Source of generated fields: local `issue.create`, `issue.comment`, `issue.link`/`item` in `src/blocks/work/entry.cts`; cloud `issue-create.ts`, `issue-comment.ts`, `issue-link.ts`, `issue-read.ts`; envelope generation in `src/core/state/index.ts`.

**Local-breach inventory, required before any R3 restore.** Stop/isolate every local writer, including stale binaries that ignored the freeze; a lane stop alone is insufficient. If isolation cannot be established, do not replace the store.
Export the current local store privately with hashes and save its raw records, leases and event history. Keep it immutable alongside frozen S7.
Diff raw rows by key/value/revision and enumerate every event after frozen S7's high-water mark, including intermediate writes later overwritten or deleted. Ignore no fields in this breach diff.
List every local write in the reconciliation ledger, even if its final value equals S7. Link local-only records and collisions to replay actions or the owner's named loss acceptance before replacing the store.
Retake the export after isolation and verify no new local events/row changes; if writers or history coverage remain uncertain, keep both stores and stop. No local-only comment may disappear merely because cloud comparison passes.

| Check                 | Tool and expected comparison                                                                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 Six-table copy     | Restore plus independent dump matches expected rows/digests for `state_records`, `state_events`, `state_leases`, `state_requests`, `domain_cloud_requests`, `domain_cloud_command_receipts`. Expected image is this bundle plus validated restore-stop rows; ignore no fields.                                                                     |
| V2 Cross-machine      | A comments on proof, every host reads it; each host comments, A reads every comment. Exact text and append order.                                                                                                                                                                                                                                  |
| V3 Local fence        | Fresh export matches frozen S7 in raw imported records and event high-water mark; source/config hashes unchanged by export. Second unbound checkout's agreed write is `UNAVAILABLE`. Any mutation triggers local-breach inventory immediately, then R3. Preserve both authorities' changes before replacement; never lift the freeze to reconcile. |
| V4 Routing refusal    | Bound project memory write is `UNAVAILABLE`; `forge store reinit --dry-run` and unsupported `forge issue tree <id>` are `INPUT_INVALID`, exit 6; verify no local mutation/fallback.                                                                                                                                                                |
| V5 Admission          | Wrong project command returns 403 `AUTH_FORBIDDEN`; target without credential returns 401 `AUTH_REQUIRED`.                                                                                                                                                                                                                                         |
| V6 Recorded writes    | Fresh cloud dump/status accounts for every proof, comment, lease and resume write since V1. Compare all six tables with baseline plus ledger effects, ignoring no fields; counts alone do not pass.                                                                                                                                                |
| V7 Missing credential | In a private sandbox binding without credential, `forge issue list` refuses with no local answer. Never delete a real credential to practise this.                                                                                                                                                                                                 |

The 11:13Z rehearsal restored four pages and matched all six digests; its older delta tool reported 0/0/0.
Its raw export had 9146 records, converter N=7380 and F=1117; restore added two record/event pairs.
With PR 653, derived allocation floors may appear as new against the raw/upgraded input. Step 3.7 requires their exact by-key bundle values, not raw 0/0/0 or F=1117.
Use this run's manifest, repair inventory, derived floors, stop window and reports for every acceptance value.

## Rollback

Owner veto V-642-manual-rollback is taken: restore S7, then re-enter cloud writes by hand from the delta report.
PR 642 (forge-1581) is closed and parked. No automated rollback apply step is allowed.
Keep the local freeze and stop from step 2 until R3.7 passes. A refusal never authorizes an unfreeze.

**R0. Finish a rollback only.**
Before step 5, when no cloud writes or binding exist, confirm S7/current local content agrees except recorded preparation writes.
Otherwise require the entire R2 or R3 path to have passed. R1 never calls R0 itself.
Only now begin the local approval flow. Keep sessions stopped until both unfreeze and resume succeed.

1. Run `forge lane unfreeze --input '{}'` locally. Expect `APPROVAL_REQUIRED` with `result.request.id` and `result.request.ask`; the store remains frozen. Present that exact ask to the owner in chat and wait for their reply.
2. Copy the owner's affirmative reply verbatim, recording the harness and thread where it was given. Never invent a quote, treat silence as approval, or reuse the cloud resume request. Save exactly that reply in a private UTF-8 file, preserving line endings and adding no newline. The commands read the whole file without trimming; prompts take the request id and reply source as data. Serialize the payload once and pass the variable without evaluation:

```powershell
$UnfreezeReply = [IO.File]::ReadAllText((Read-Host 'Exact unfreeze reply UTF-8 file'), [Text.Encoding]::UTF8)
$UnfreezeInput = @{approval=@{request=(Read-Host 'Unfreeze request id'); quote=$UnfreezeReply; source=@{harness=(Read-Host 'Reply harness'); thread=(Read-Host 'Reply thread')}}} | ConvertTo-Json -Compress -Depth 5
forge lane unfreeze --input $UnfreezeInput
```

Require `ok:true` and `result.frozen:false` from that retry before continuing. A request id alone does not authorize local unfreeze.

3. Run `forge lane resume --input '{"all":true}'` locally. Expect a separate `APPROVAL_REQUIRED` request; lanes remain stopped. Present its `result.request.ask` to the owner and wait for a new verbatim affirmative reply with its harness/thread.
4. Save this separate reply in its own private UTF-8 file under the same exact-text rules. Build and pass its payload as data, then require `ok:true` and `result.resumed:"all"`:

```powershell
$ResumeReply = [IO.File]::ReadAllText((Read-Host 'Exact local resume reply UTF-8 file'), [Text.Encoding]::UTF8)
$ResumeInput = @{all=$true; approval=@{request=(Read-Host 'Local resume request id'); quote=$ResumeReply; source=@{harness=(Read-Host 'Reply harness'); thread=(Read-Host 'Reply thread')}}} | ConvertTo-Json -Compress -Depth 5
forge lane resume --input $ResumeInput
```

Local requests bind the operation, unchanged arguments, project and device; they expire after 24 hours and are consumed once. Missing/expired/used/mismatched requests return `APPROVAL_REQUIRED`: call that operation without approval to obtain a new request and ask the owner anew. A reply over 2000 characters needs a new shorter owner reply; never shorten it yourself. No dry-run, typed terminal confirmation or owner policy bypasses these local gates.
Only after both results pass tell sessions to continue. Retain the unused cloud project; no project-delete route is supplied here.
Approval shapes checked on `origin/main` at `e2983271`: `src/assembly/index.ts`, `src/assembly/approval.ts`, `src/blocks/work/schemas/unfreeze.input.json`, `src/blocks/work/schemas/lane-resume.input.json`; cloud refusal/browser flow in `cloud/src/issue-commands.ts` and `cloud/src/lane-approval.ts`.

**R1. Fence cloud writes without unfreezing local writes.**
Restore saved Worker admission vars/config, preflight and redeploy via the authorized operator.
Call the switched project's typed command route and require 403 `AUTH_FORBIDDEN` before taking a rollback dump.
Admin dump/status still work. Restrict admin access to this operator and revoke saved device token ids to fence raw lease calls too.
Do not assume `wrangler rollback` restores vars. Read admission back explicitly.
Return to the caller, R2 or R3.2. Never run R0 from R1.

**R2. After binding, before any cloud write.** Depends on PR 626.
Fence with R1. For each bound checkout revoke its recorded server token id, then have the human operator run `forge auth logout`.
It removes only that project's credential, verifies the write, then deletes the binding using the exact bytes read by `readBindingSnapshot`.
A changed binding is `INPUT_CONFLICT`; unsafe credential storage is `ACCOUNT_INTEGRITY`; stop and reconcile rather than hand-edit.
Logout reports `tokenRevoked:false`; admin revoke is still required. Retain login's token id if logout only removes a leftover binding.
Verify each checkout is unbound, credential association removed without printing it, and local writes still refused by the freeze.
If step 9 merged, do R3.5's binding revert. Only after all readbacks pass, with zero cloud writes, run R0.

**R3. After any cloud write.** Depends on PRs 626, 652 and 653 and P13/P14.

1. Tell every session to stop; stop cloud dispatch while still admitted. This is not the write fence. Keep the local freeze set, including throughout restore and replay. If the practised restore/single-writer paths in P13/P14 are missing, stay frozen and repair forward or stop for that dependency; never improvise an unfreeze.
2. Run R1 and verify its cloud fence. R1 returns here, with local freeze still on. Account for/revoke every device token and prevent any admin writer during the dump and replay.
3. Read admin status, capture every page, then read status again. Six counts must agree. Use a fresh `$Dump` directory inside the private ledger. Set `$AdminTokenEnv` to the variable name used by the guarded admin helpers.

```powershell
$CaptureNotBefore = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
$CaptureJson = bun tools/cloud-to-local-delta.ts capture --worker $Origin --project $Project --out $Dump --token-env $AdminTokenEnv
if ($LASTEXITCODE -ne 0) { throw 'Cloud capture refused' }
$Capture = ($CaptureJson | ConvertFrom-Json).result
```

Record `$CaptureJson` and `$CaptureNotBefore` in the protected rollback ledger outside `$Dump` and use those recorded values in R3.4. Take the receipt digest from the capture command's output. Validate the page chain and digests. `DUMP_CHANGED`, a missing page or target mismatch stops rollback. Enumerate every cloud event after the saved post-restore baseline, including overwritten or deleted intermediate writes, and reconcile by sequence and key with the materialized delta. Name superseded actions in the ledger.

4. Before replacing any local store, perform Verification's local-breach inventory even if V3 passed. Run the read-only delta against the retained upgraded converter input. Classify its report against the saved converted baseline from step 3.7, including derived floors. Only later changes belong in the cloud replay ledger.

```powershell
bun tools/cloud-to-local-delta.ts --dump $Dump --backup $DeltaBackup --manifest $DeltaManifest --receipt-sha256 $Capture.receiptSha256 --not-before $CaptureNotBefore --project $Project --out "$Ledger/rollback-delta.json"
```

`INPUT_INVALID` stops rollback on a wrong project, a missing or mismatched receipt, a capture before the fence, stale or missing pages, a bad cursor chain, duplicate keys, a hash mismatch, sidecars, or existing output.
Check every new, changed and `absentInCloud` entry, floor advance and `notCarriedBack` item. Merge cloud changes and the local-breach inventory into a ledger keyed by authority, event sequence and record key. For each entry record before/after, replay action/readback or the owner's explicit loss acceptance by name. Resolve conflicting updates and colliding ids explicitly; an unexplained or unclassified entry blocks store replacement.

5. On every host revoke recorded token ids, then run PR 626 logout as in R2; verify binding/credential removal without exposing secrets. Revert the step 9 binding commit through a normal PR and merge it via the authorized owner. Record the revert commit and verify every host/worktree has pulled it; logout again on any checkout that regained the binding. Keep the local freeze; this is the binding reversal that step 9 points to.

6. Only after both inventories and every disposition are saved, restore the immutable frozen S7 from step 3.1 using P13's private staged file, hash/ACL verification and atomic freeze preservation. Read back against frozen S7. The sole P14 writer manually replays the reconciled cloud and local-breach actions with issue create/comment/link/update/dep/close and required claims. Read back every action using Verification's `replay-check`. Preserve ids, keys, references and append order; any necessary remap or unrepresentable field needs an explicit named loss decision, not silent skipping. No other writer may run. Keep the freeze set.

7. Export the replayed store read-only. Run `replay-check` against frozen S7 plus the reconciled cloud and local-breach ledger, not just the final cloud dump. Require every event/action to have its checked result or named owner-accepted loss; verify both source inventories are fully covered and every final record is accounted for. Compare effective allocation floors from local records/history with the expected floors, not merely the presence of derived allocation rows. Recheck all other writers remain refused. Only then run R0. Any mismatch leaves local frozen and cloud unadmitted.

8. Manual replay regenerates the metadata listed in `replay-check`; it does not restore cloud history, lease generations or request receipts. Name each affected key/field and every `notCarriedBack` item in the loss ledger with owner acceptance. No blanket timestamps/authors exemption applies to untouched records.

## Gaps

| Dependency                          | Execution gate                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 652 atomic freeze                | Step 2 and rollback need freeze refusal across runtime, lease and landing writes, including races. Pending merge and pinned-build practice.                                  |
| PR 626 logout                       | R2/R3.5 need byte-checked binding removal; practise on a hand-built binding whose identity matches a sandbox project UUID, without login/browser or real credential changes. |
| PR 653 delta, forge-1622            | R3.4 needs allocation-floor changes, pinned dump/project provenance and verified backup bytes. PR 653 is open with the fix, pending its merge gate.                          |
| P13 retained upgrade and S7 restore | Converter deletes internal scratch. Keep a separately upgraded input; practise private ACL setup, restore and uninterrupted freeze before switch.                            |
| P14 single-writer replay            | No command supplied. A dispatch stop or lifting freeze is insufficient; switch blocked until a practised single-writer mechanism exists.                                     |
| Project deletion/retention          | No delete step; retain unused cloud project and S7 for the recorded period.                                                                                                  |

## Not verified

- This document has not executed a switch, restore, login, logout, freeze, replay or rollback on the real tracker.
- Whether every machine/clone uses the pinned build and shares the inventoried store; verify P7/P12 at execution.
- Whether `issue.board` includes lane and attempt leases. It lists open issue holders, live/stale state and expiry, not acquired time or generation.
- Whether the required single-writer replay and freeze-preserving S7 restore can be performed on the shipped build. P13/P14 block, rather than assume this.
- Whether the step 3 ledger already retains the upgraded backup. Its original brief names the raw export; inspect artifact metadata privately and prepare the missing copy before P4 passes.
- Final behaviour after PRs 626, 652 and 653 merge; re-read final code and practise required refusals on that build.
- Whether Worker rollback restores var values; R1 uses explicit saved vars and readback instead.

## Decisions needed

No new owner decision for this rewrite. Manual S7 restore plus hand re-entry is the taken rollback policy.
A. Proceed only after P1 to P14 pass, redo the full copy into a new project on content drift, retain backups 30 days (default).
B. Defer the switch and repair dependencies first. Neither choice authorizes bypassing the freeze or acknowledgement.
Valid replies: A or B. Silence keeps A's gates in force; it does not start execution.
