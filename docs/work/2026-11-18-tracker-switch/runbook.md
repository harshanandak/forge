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
`$Ledger` is `E:/forge-move-ledger/<stamp>/`, private and outside every repo.
`$Project`, `$Origin`, the S7 snapshot path and all expected values come from step 3's `run.json` there.
`$Bundle` holds retained or regenerated converter pages; `$Dump` holds a complete paged cloud dump.
`$DeltaBackup` and `$DeltaManifest` name the retained upgraded converter input and its `source.json`.
Keep the immutable raw S7 export separately. Never substitute it for `$DeltaBackup`.
Admin helpers read credentials in-process, print no secret, follow no redirect and check the exact target before every call.
Use the step 3 reviewed helpers for status/dump/revoke; endpoints are `/p/$Project/{status,dump,revoke}`.
Never put bearer bytes on a command line, print a credential file, or copy credentials between machines.

The binding identity is the UUID in `.forge/project.json`, not the cloud project name.
`.forge/cloud.json` travels in git; each machine's credential does not.
Bound issue commands route to cloud; unbound worktrees sharing the store need the local freeze.
A lane stop stops dispatch, not issue writes. A Worker admission change fences typed commands, not admin routes or raw leases.

Source pointers on the cited main: `src/assembly/store-export.ts`, `tools/import-current.ts`,
`tools/restore-cloud.ts`, `tools/cloud-to-local-delta.ts`, `src/blocks/work/entry.cts` (`board`, `laneFreeze`, `laneUnfreeze`),
`src/blocks/work/docs.json` (`issue.board`) and `src/assembly/cloud-authority.ts`.
Pending behaviour comes from the diffs of PRs 626, 652 and 653, not an assumption that they merged.
Asset: the tracker and every cloud write after the copy. Threat: a replay race or wrong-project comparison loses writes.
Mitigation: keep the freeze set, fence cloud before dumping, and require complete comparisons plus a practised single writer.

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
| P10 Owner present          | Owner can approve each machine's login and cloud resume. Logout practice uses a hand-built sandbox binding, without the owner's browser.                                                                                                                                        |
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
4. Capture the frozen read-only local view and export in step 3. Save every issue, including closed issues, every comment and link, following pagination. Require completed pagination, with no result left truncated. Keep all artifacts private.

Do not release or renew a lease, stop/resume local lanes, or lift the freeze after 2.3.
PR 652 makes those mutation paths refuse while frozen. Read-only board/list/export remain checks, not permission to write.

**Step 3. Check the final delta and keep both backup forms.**

1. Run `forge store export --input '{"out":"<fresh private ledger folder>"}'`. Hash the source database and project config before and after with the reviewed read-only helper; both hashes must match. Export uses a read-only store and writes `backup.sqlite`, `source.json`, `export-info.json` only in the destination. A nonempty destination is `INPUT_CONFLICT`; missing store is `UNAVAILABLE`; invalid input is `INPUT_INVALID`. Stop on any refusal or hash mismatch.
2. Compare frozen export to P4 by key, value, revision and `updatedAt` for all imported work records, including issues, comments, links, dependencies and allocation floors. Only recorded preparation writes from 2.1, 2.2 and the freeze write in 2.3 may explain changed local runtime/lease/event records or high-water increments. Unexplained movement stops the switch. Do not assume byte-identical SQLite exports for equal data.
3. Any imported-content difference requires a fresh full copy into a new project, with a new acknowledgement and all six readbacks. An empty-project restore is not incremental import. Restart P1; keep the local freeze set throughout.
4. Before Forge opens any copied store, set/check owner-only ACLs on its private parent and file. Step 3's preparation helper must use `privateFileGuard(windowsPrivateFiles())` and private copy/file operations; ordinary `Copy-Item` and a read-only attribute do not establish privacy. Verify ACLs before opening even read-only. Keep raw S7 immutable; upgrade only a private copy with the pinned migrations. Close it without sidecars, save its SHA-256 in its own source manifest, preserving the export `at` and recording the upgraded record count and event high-water mark. Reconcile every migration change against raw S7. This retained upgraded copy is the converter's input and `$DeltaBackup`. No helper that does this is specified here; P13 requires its practised procedure.
5. Regenerate a bundle if needed, using two fresh output directories. The converter's own internal migrated scratch is deleted on exit; it is not the retained upgraded backup. Run:

```powershell
bun tools/import-current.ts --backup $DeltaBackup --manifest $DeltaManifest --out "$Ledger/bundle-first"
```

Expect `INPUT_INVALID`, exit 6, `Offline import refused; no verified complete bundle`, with `left-behind.json` but no verified manifest.
Only this acknowledgement refusal is expected. Read the inventory and live-lease keys; do not mistake another failure for the gate.
Require zero live leases and the family set in What stays local. Hash this run's file and obtain acknowledgement for this inventory:

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

7. Dump all pages independently with the reviewed step 3 helper, pinned to `$Project`; save page hashes and project provenance. Compare all six digests to restore readback, then run the delta tool as in R3.4. Before cloud writes, require 0 new, 0 changed, 0 absent. Retain raw S7, upgraded input/manifest, bundle manifest, left-behind inventory, restore/readback/delta reports and `run.json` read-only in the private ledger. Regenerate pages before removing them if a later comparison needs them.

**Step 4. Check capacity and target.**
Read admin status and usage for exactly `$Project`. Compare all six counts/digests with step 3's final baseline and usage with configured Worker limits.
Keep the restored all-lanes stop. An unexplained delta, missing report or limit refusal stops the switch.

**Step 5. Admit the new project.**
The authorized operator sets `FORGE_CLOUD_PROJECT=$Project`, preserves the saved resource/prefix values, runs `cloud/scripts/preflight.mjs` and deploys with the private `wrangler.local.jsonc`.
Read status for `$Project`; typed command on a different project must return 403 `AUTH_FORBIDDEN`.
An unauthenticated command on `$Project` must return 401 `AUTH_REQUIRED`. On failure use R1, then the applicable rollback; do not unfreeze.

**Step 6. Bind machine A.**
Confirm project UUID/prefix from P9. Enable the cloud block through the approved config change.
Run `forge auth login --origin $Origin --project $Project`; the owner approves in the browser.
Save returned origin, project, device, token id and expiry in the ledger; never the token.
Login writes the binding last after credential readback. Verify binding UUID/origin/project against P9 and `run.json`.
The freeze from step 2.3 still fences every unbound worktree. Any login/integrity refusal stops the switch.

**Step 7. Compare through cloud.**
Read every issue, comment and link through the bound CLI, including closed issues and all pages.
Use `same` as defined in Verification against step 2.4. Require equality for every id/value; save comparison results.
Check known open and closed issues and one with comments using `forge issue show <id>`.
Mismatch before cloud writes takes R2; mismatch after any write takes R3.

**Step 8. First cloud write and readback.**
Create one permanent proof issue with `forge issue create --input '{"title":"tracker switch proof","kind":"task"}'`.
Require `ok:true`, read it back, and compare its number with the restored allocation floor; never require highest-live-id plus one.
Claim it, comment `switch proof from machine A`, then close using an explicit `withoutReceipt` reason.
Read back each result; record the proof id and every write/lease effect in the ledger. Any refusal now takes R3.

**Step 9. Commit the binding.**
Commit `.forge/cloud.json` and the approved cloud-block config change through a normal PR.
Record the merged binding commit. R3 step 5 reverts that commit; R2 alone does not undo git history.
Keep the local freeze while the binding reaches every worktree and host. Failure after step 8 takes R3.

**Step 10. Bind every other machine and host.**
Pull step 9's commit, install P7's build, and run `forge auth login` with owner browser approval per device.
Each host reads the proof issue and writes a uniquely labelled comment; A reads every comment back.
Inventory every checkout, UUID, origin, project and token id. No copied credentials. Plan re-login before the 30-day expiry.

**Step 11. Lift the cloud dispatch stop.**
Run `forge lane resume --input '{"all":true}'`, obtain owner approval, then rerun with `approval` set to the request id only.
Cloud refuses `quote`/`source` with `INPUT_INVALID`; per-lane resume cannot clear the all-lanes stop.
Read `forge lane control` back and require no all-lanes stop. This changes no local freeze.

**Step 12. Verify and retain.**
Run every Verification row. Retain the frozen store and both immutable backup forms for 30 days by default.
No deletion, local unfreeze or local resume completes a successful switch.

## What stays local

The 11:13Z practice inventory had these families; require this set, not its counts:
`forge/check runs/*`; `forge/core-project identity`; `forge/memory meta/*`, `note/*`, `transfer/*`;
`forge/work autopilot-ask:*`, `autopilot-clock:*`, `autopilot-event:*`.
That practice had 1766 left behind and 2 live leases; those are not acceptance counts. Real-copy acceptance requires zero live leases.
Any new family needs review and a new acknowledgement before conversion proceeds.

The backup also retains old event history, local runtime state, old leases, requests and receipts.
Import creates current values with fresh revision-1 events, not the old history. Old fences cannot authorize cloud writes.
Device memory stays on device. Generic project memory/decisions/check-receipt writes are refused while cloud-bound.
`issue.board`, call/checkpoint/resume/events/tree/lint/invite/join/leave and `attempt.*` are not cloud-served.
Bound lane operations have their own coordinator; do not infer that all work commands fall back locally.

## Verification

`same` is a read-only comparison procedure, not an installed command: enumerate all issues and each one's comments and links on both sides.
Reject unfinished pagination, duplicate or missing ids. Sort issues by id and comments/links by their numeric key within each issue.
Compare every issue value field, dependencies and all comment/link values, retaining ids and append order.
Ignore only import-generated envelope `revision`, `updatedAt`, `updatedBy`; never discard those names inside user values.
Record totals and all differences. Success means zero differences across the full enumeration, not a sample.
For R3, derive the expected view from the fenced cloud dump; never compare only with the pre-switch local view.

| Check                 | Tool and expected comparison                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 Six-table copy     | Restore plus independent dump must match expected rows/digests for `state_records`, `state_events`, `state_leases`, `state_requests`, `domain_cloud_requests`, `domain_cloud_command_receipts`. Expected image comes from this bundle plus the validated generated restore-stop window.   |
| V2 Cross-machine      | A comments on proof, every host reads it; each host comments, A reads every comment. Match exact text and append order.                                                                                                                                                                   |
| V3 Local fence        | Fresh read-only local export equals step 3 frozen baseline by all imported records and high-water mark; source/config hashes unchanged by export. Second unbound worktree's agreed write remains `UNAVAILABLE`. Any mutation stops work and takes R3; never replay by lifting the freeze. |
| V4 Routing refusal    | Bound project memory write is `UNAVAILABLE`; `forge store reinit --dry-run` and unsupported `forge issue tree <id>` are `INPUT_INVALID`, exit 6. No local mutation or local fallback.                                                                                                     |
| V5 Admission          | Wrong project command returns 403 `AUTH_FORBIDDEN`; target without credential returns 401 `AUTH_REQUIRED`.                                                                                                                                                                                |
| V6 Recorded writes    | Fresh cloud dump/status accounts for every proof, comment, lease and resume write since V1. Compare all six tables with baseline plus ledger effects; equal row counts alone do not pass.                                                                                                 |
| V7 Missing credential | In a separate private sandbox binding with no credential, `forge issue list` must refuse with no local answer. Never delete a real credential to practise this.                                                                                                                           |

The 11:13Z rehearsal restored four pages, matched all six digests and produced delta 0/0/0.
Its raw export had 9146 records, converter N=7380 and F=1117; restore added two record/event pairs.
These numbers explain expected shape only. Use this run's manifest, stop window and reports for every acceptance value.

## Rollback

Owner veto V-642-manual-rollback is taken: restore S7, then re-enter cloud writes by hand from the delta report.
PR 642 (forge-1581) is closed and parked. No automated rollback apply step is allowed.
Keep the local freeze and stop from step 2 until R3.7 passes. A refusal never authorizes an unfreeze.

**R0. Finish a rollback only.**
Before step 5, when no cloud writes or binding exist, confirm S7/current local content agrees except recorded preparation writes.
Otherwise require the entire R2 or R3 path to have passed. R1 never calls R0 itself.
Only now may the owner run `forge lane unfreeze --input '{}'` locally and read back `frozen:false`.
Then locally resume all lanes with owner approval and tell sessions to continue. Retain the unused cloud project; no project-delete route is supplied here.

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
3. Read admin status, dump every page, then status again. Six counts must agree; validate page chain and digests. `DUMP_CHANGED`, missing page or target mismatch stops rollback. Retain final dump privately with a manifest containing exact project and each page's name/SHA-256, produced by the guarded exporter at capture, not invented later.
4. Run the read-only `tools/cloud-to-local-delta.ts` against the retained upgraded converter input, never raw S7. With PR 653's required implementation use:

```powershell
bun tools/cloud-to-local-delta.ts --dump $Dump --backup $DeltaBackup --manifest $DeltaManifest --dump-manifest "$Dump/export.json" --project $Project --out "$Ledger/rollback-delta.json"
```

The flags `--dump-manifest`/`--project` are PR 653 dependencies, unavailable on the cited main.
PR 653 is open with the fix at `48de4d4d956ff9d5b5ee76f172a74ffeb07be475`, pending its merge gate; require merge and refusal evidence before P13 passes.
`INPUT_INVALID` stops on wrong project/provenance, stale/missing pages, bad cursor chain, duplicate keys, hash mismatch, sidecars, or existing output.
Check every new, changed and `absentInCloud` entry plus allocation-floor changes and `notCarriedBack`; map each to a manual action or an explicit loss decision.

5. On every host revoke recorded token ids, then run PR 626 logout as in R2; verify binding/credential removal without exposing secrets. Revert the step 9 binding commit through a normal PR and merge it via the authorized owner. Record the revert commit and verify every host/worktree has pulled it; logout again on any checkout that regained the binding. Keep the local freeze; this is the binding reversal that step 9 points to.

6. Restore immutable S7 with the exact P13 procedure, using a private staged file, verified hash and ACLs before Forge opens it. Never overwrite S7. Preserve/reapply the freeze atomically before exposing the restored store; no writable interval is allowed. Read back restored records against S7. Then the sole P14 writer manually re-enters cloud changes from the delta using issue create/comment/link/update/dep/close, with claims where required. Preserve ordering, check every allocated id and floor against the dump, and record each action/result. Missing ids, deletions, floor advances or any value the CLI cannot reproduce block completion; never silently renumber or skip. No other session may write; the freeze stays set.

7. Export the replayed local view read-only. Run `same` against the fenced final cloud dump for every issue, dependency, comment and link, and compare allocation floors. Require zero unexplained differences and account for every delta entry. Recheck that all other writers remain refused. Only after this passes may R0 unfreeze/resume. A failure leaves local frozen and cloud unadmitted.

8. Lost even after value replay: original cloud event history, revisions/timestamps/authors, lease generations and request receipts. Record all `notCarriedBack` losses and owner acceptance; do not claim a full database inverse.

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
