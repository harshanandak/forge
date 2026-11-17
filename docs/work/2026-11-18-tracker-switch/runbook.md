# Tracker switch runbook (step 4: the authority switch)

Nothing here runs now. This runbook starts only after step 3 passes. It makes the cloud project the one place that accepts issue writes, and it retires the local store as authority. Refs tracker-move-4-switch.

Evidence base: `origin/main` at `0ec6b194`. A citation `path:line` is rung 2 (read the line). Nothing below was run. The practice scripts named in Gaps are local and untracked, so their lines are not on main.

Decisions needed: three, listed at the end, each with a default.

Notation: `forge` means `node "$BIN"` (the installed build, per `docs/reference/cloud.md:28`). `$ORIGIN` is the Worker origin. `$PROJECT` is the step 3 cloud project name. Credentials never appear on a command line; admin calls use a private curl config file, as in `docs/reference/cloud.md:378`.

## How the code decides where authority lives

1. A checkout is cloud-bound when `.forge/cloud.json` exists and matches `.forge/project.json` (`src/assembly/cloud-binding.ts:32-47`). The file is committed and holds no secret (`.gitignore:24-28`).
2. A bound checkout sends sixteen `issue.*` operations and `lane.stop`, `lane.control` and `lane.resume` to the cloud, and opens no local store for them (`src/assembly/cloud-authority.ts:1-2`, `:75-95`). Other work operations are refused by name (`:98-107`).
3. A bound checkout refuses local project-state writes with `UNAVAILABLE` (`src/assembly/cloud-authority.ts:48-60`, wired at `src/assembly/index.ts:322`) and refuses `store reinit` with `INPUT_INVALID` (`src/assembly/cloud-authority.ts:102-103`, `docs/reference/cloud.md:178`).
4. The Worker admits one project for commands and login: `FORGE_CLOUD_PROJECT` (`cloud/src/worker.ts:90`, `:177`).
5. The local store is per machine and not in git (`.gitignore:25`, `src/assembly/index.ts:306-314`). Only this laptop has the real tracker. Other machines have no tracker to write to.
6. An unbound checkout that still holds a saved credential for the project is refused with `INPUT_CONFLICT` (`src/assembly/cloud-binding.ts:48-56`). This matters for rollback.

## 1. Preconditions

Do not start until every item is true. Record each result in the move ledger.

| #   | Precondition                          | How to check                                                                                                                                   | Pass                                                                                        |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P1  | Step 3 restore finished               | Step 3 report: every restore page accepted, final status read (`docs/reference/cloud.md:226`, `:278`)                                          | Report says `verified: true`                                                                |
| P2  | Six tables match                      | Paged dump readback compared with the expected image (`docs/reference/cloud.md:278-280`, `:282`)                                               | All six table counts and content digests match; stop-delta rows account for every extra row |
| P3  | Left-behind inventory acknowledged    | The acknowledged digest in the bundle manifest equals the digest of `left-behind.json` (`docs/reference/cloud.md:272`)                         | Digests equal; manifest `activation` is still the pre-activation warning (`:282`)           |
| P4  | Step 3 source recorded                | Step 3 `source.json`: `sha256`, `eventHighWaterMark`, `records`, `at` (`docs/reference/cloud.md:261`)                                          | Four values saved in the ledger                                                             |
| P5  | Project holds no writes since restore | Admin `status` rows equal the step 3 final rows (`docs/reference/cloud.md:230`)                                                                | Equal for all six tables                                                                    |
| P6  | No live claims on the local store     | Step 3 left-behind report lists the live-lease count at backup time (`docs/reference/cloud.md:272`, `:284`). Re-check at freeze (step 2 below) | Zero. Leases are never imported (`docs/reference/cloud.md:276`)                             |
| P7  | Same build on every machine           | `forge --version --json` and `dist/build.json` (`docs/reference/cloud.md:24-25`)                                                               | Identical `version`, `commit`, `dirty: false` on all machines                               |
| P8  | Worker secrets set                    | `DEVICE_LOGIN_HMAC_KEY` and `ADMIN_TOKEN` exist; owner vars set (`docs/reference/cloud.md:196`, `:357`)                                        | Preflight passes (`docs/reference/cloud.md:369`)                                            |
| P9  | Id prefix agrees                      | Worker `FORGE_CLOUD_ID_PREFIX` equals the work block `idPrefix` in `.forge/config.yaml` (`docs/reference/cloud.md:339`)                        | Equal strings                                                                               |
| P10 | Owner at a browser                    | One approval per machine login and one for lane resume (`docs/reference/cloud.md:28`, `:200`)                                                  | Owner present for the whole run                                                             |
| P11 | Reverse path saved                    | Prior Worker version, a copy of the prior `wrangler.local.jsonc`, the immutable local backup (`docs/reference/cloud.md:284`, `:366`)           | All three stored privately                                                                  |

Versions. Every machine must run one exact build that contains the cloud routing above. Main now carries `0.1.0-beta.9` (`package.json:3`, `docs/release.md:13`). I did not check which build any machine has. Treat that as unknown until P7 runs. Install the same archive on all machines with fresh prefixes, as in `docs/reference/cloud.md:14-25`. Never use a `forge` found on PATH.

## 2. The switch

Run the steps in order. Stop at the first failure and use the matching rollback in section 5.

**Step 1. Save the reverse path.**

```sh
bun x wrangler deployments list --config wrangler.local.jsonc   # from cloud/; note the current version id
cp wrangler.local.jsonc wrangler.local.jsonc.before-switch      # private copy
```

Write the current `FORGE_CLOUD_PROJECT`, `FORGE_API_RESOURCE` and `FORGE_CLOUD_ID_PREFIX` values in the ledger (`docs/reference/cloud.md:334-339`).

**Step 2. Freeze local writes.** The code has no command that makes the local store read-only (Gap 1). Freeze by procedure:

1. Tell every session on this laptop to stop issue work. Close or pause each agent.
2. For each open claim, release it from the local store: `forge issue release <id>`. Claims are not imported (`docs/reference/cloud.md:276`).
3. Stop dispatch: `forge lane stop --input '{"all":true}'`. Stop needs no approval (`src/blocks/work/docs.json:101-104`). It stops lanes only. It does not block `issue.*` writes.
4. Record the local issue list before binding changes the route: `forge issue list --input '{"limit":1000}' > local-list.json`. Keep it private. Expect `"truncated": false`.

**Step 3. Final delta check between local and cloud.** There is no incremental import. A restore needs an empty project (`docs/reference/cloud.md:226`), so the only test is whether the local store changed since the step 3 snapshot.

1. Take a new read-only export of the frozen local store, as step 3 did, and write a new `source.json` (`docs/reference/cloud.md:261`).
2. Compare `eventHighWaterMark` and `records` with P4.
3. Equal: the step 3 project is current. Go on.
4. Different: stop. Repeat step 3 into a new project name, then restart this runbook at P1. Never write local changes into the existing project by hand.

Every local write adds an event, so an equal high-water mark means no write (`src/core/state/index.ts:2306-2318`). Equal `sha256` is not required, because the image bytes may differ without a data change. I have not shown that they never do.

**Step 4. Confirm the cloud project is untouched.**

```sh
curl -sS --config '<admin-curl-config>' "$ORIGIN/p/$PROJECT/status"
```

Expect HTTP 200, `value.initialized: true`, and `value.dump.rows` equal to P5 for all six tables (`docs/reference/cloud.md:230`, `:406`). Then rerun the step 3 paged readback and comparison once. Expect six matching digests.

**Step 5. Admit the project on the Worker.** This is the cloud-side switch. Everything else is per machine.

1. In `wrangler.local.jsonc` set `FORGE_CLOUD_PROJECT` to `$PROJECT`, `FORGE_API_RESOURCE` to `$ORIGIN/p/$PROJECT`, and `FORGE_CLOUD_ID_PREFIX` to the P9 value (`docs/reference/cloud.md:334-339`).
2. From `cloud/` run the preflight, then deploy only if it passes (`docs/reference/cloud.md:369-375`):

```sh
node scripts/preflight.mjs --config wrangler.local.jsonc
bun x wrangler deploy --config wrangler.local.jsonc
```

3. Run the smoke checks that apply (`docs/reference/cloud.md:403-423`). Expect: `status` 200 with `initialized: true`; `POST /p/$PROJECT/command` with body `{}` and no token gives 401 `AUTH_REQUIRED`; the same call on any other project name gives 403 `AUTH_FORBIDDEN` (`cloud/src/worker.ts:90-103`).

Once this deploy lands, the Worker answers commands and login for `$PROJECT` only. Any earlier admitted project is cut off at once.

**Step 6. Bind machine A.** On this laptop, in the checkout:

1. Confirm `.forge/project.json` exists. Login never creates it (`docs/reference/cloud.md:208`).
2. Enable the cloud block in `.forge/config.yaml`: `blocks: { cloud: { source: { builtin: forge/cloud } } }` (`docs/reference/cloud.md:208`).
3. Log in. Set `FORGE_NO_BROWSER=1` if you want to open the link yourself:

```sh
forge auth login --origin "$ORIGIN" --project "$PROJECT"
```

4. The owner opens the printed `/device?code=XXXX-XXXX` link, ticks the confirmation box, approves, and signs in at Clerk (`docs/reference/cloud.md:210`).
5. Expect one stdout result with origin, project, device, token id and expiry, and no token (`docs/reference/cloud.md:212`). The binding `.forge/cloud.json` is written last, after the credential reads back (`:214`).

From this point every `issue.*` command on this checkout goes to the cloud.

**Step 7. Read-only comparison through the cloud.**

```sh
forge issue list --input '{"limit":1000}' > cloud-list.json
```

Compare with `local-list.json` from step 2: same ids, same titles, same status, same count, and `"truncated": false`. Revisions restart at 1 on import (`docs/reference/cloud.md:270`), so compare ids and fields, not revisions. Then `forge issue show <id>` for three ids you know, including a closed one and one with comments, and `forge issue comments <id>`. Expect the same text as local.

**Step 8. First write and readback through the cloud.** This leaves one permanent proof issue; there is no delete.

```sh
forge issue create --input '{"title":"tracker switch proof","kind":"task"}'
```

Expect `"ok":true`, `"status":"OK"` and exit 0 (`src/assembly/cloud-authority.ts:314`, `docs/reference/cloud.md:49`). The new id must be one number above the highest imported issue number, never a reused number (`docs/reference/cloud.md:288-290`). Then:

```sh
forge issue show <proof-id>
forge issue claim <proof-id>
forge issue comment <proof-id> --body "switch proof from machine A"
forge issue close --input '{"id":"<proof-id>","withoutReceipt":"tracker switch proof"}'
```

Claim before close, because close needs the held lease (`docs/reference/cloud.md:158`). Expect each to return `"ok":true`.

**Step 9. Commit the binding.** Commit `.forge/cloud.json` (and `.forge/config.yaml` if changed) on a branch and merge it through the normal PR path. Other machines get the binding through git and nothing else.

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

**Step 12. Retire the local store.** Do not delete it. Keep `.forge/state.sqlite` and the immutable backup untouched until the retention period in the ledger ends (`docs/reference/cloud.md:274`, `:284`). Never point the old store at a running session again.

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

| #   | Claim                                               | Command                                                                                      | Expected                                                                                                                                                             |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | A write on A is read on B                           | A: `forge issue comment <proof-id> --body "v1"`; B: `forge issue comments <proof-id>`        | B lists the comment from A, in append order (`docs/reference/cloud.md:166`)                                                                                          |
| V2  | A write on B is read on A                           | Reverse of V1                                                                                | A lists the comment from B                                                                                                                                           |
| V3  | A bound checkout writes no issue to the local store | Rerun the read-only local export used in step 3 and read `eventHighWaterMark`                | Equal to the frozen value from step 3. No local event was added by steps 6 to 11                                                                                     |
| V4  | Local project-state writes are refused              | `forge memory add --input '{"text":"x","level":"project","scope":"switch","tags":["fact"]}'` | `ok:false`, code `UNAVAILABLE`, exit 1, message starts "This project is cloud-bound" (`src/assembly/cloud-authority.ts:54-56`)                                       |
| V5  | Store recovery is refused                           | `forge store reinit --dry-run`                                                               | `INPUT_INVALID`, exit 6, "store.reinit is not served by the cloud authority of a cloud-bound project yet." (`docs/reference/cloud.md:178`)                           |
| V6  | Unsupported ops refuse, not fall back to local      | `forge issue tree <id>`                                                                      | `INPUT_INVALID`, exit 6, "... is not served by the cloud authority of a cloud-bound project yet." (`src/assembly/cloud-authority.ts:41-45`)                          |
| V7  | The Worker admits only `$PROJECT`                   | `POST $ORIGIN/p/<any-other-name>/command` with body `{}`                                     | 403 `AUTH_FORBIDDEN` (`cloud/src/worker.ts:90-97`)                                                                                                                   |
| V8  | Cloud and ledger agree                              | Admin `GET status`                                                                           | Rows equal step 3 rows plus exactly the writes from steps 8, 10 and V1 to V2, nothing else                                                                           |
| V9  | A checkout with no credential fails closed          | On a bound checkout with no saved credential run `forge issue list`                          | Expected: a refusal from the cloud client, not a local answer. The route never falls back to the local store (`src/assembly/cloud-authority.ts:277-281`, `:291-299`) |

V4 and V5 prove the local store is refused for project state. They do not prove it is impossible: a checkout that lacks `.forge/cloud.json` (an old branch, or a copy made before step 9) is unbound and writes locally with no warning (`src/assembly/cloud-binding.ts:48-52`). Check every checkout on this laptop with `git status` for the binding file before declaring done. Gap 1 covers a real fence.

## 5. Rollback

Never run two writable authorities (`docs/reference/cloud.md:284`). Pick the row that matches how far the switch got.

**R0. Before step 5 (Worker not changed).** Nothing left this laptop. Run `forge lane resume --input '{"all":true}'` on the local project (owner approves), and tell sessions to continue. The step 3 cloud project stays. There is no project delete (Gap 7).

**R1. After step 5, before any machine is bound.** Put the old vars back. Redeploy the saved copy:

```sh
cp wrangler.local.jsonc.before-switch wrangler.local.jsonc
node scripts/preflight.mjs --config wrangler.local.jsonc
bun x wrangler deploy --config wrangler.local.jsonc
```

An alternative is `bun x wrangler rollback <version-id> --config wrangler.local.jsonc` with the id from step 1. It swaps code only and does not undo stored data (`docs/reference/cloud.md:467`). I did not check whether it also restores var values, so prefer the redeploy and read back the vars with the smoke checks. Then do R0.

**R2. After binding a machine, before any cloud write (before step 8).** On each bound machine:

1. Delete `.forge/cloud.json` and do not commit it.
2. Remove the saved credential for this project. There is no logout command (Gap 6). If `~/.forge/cloud/credentials.json` holds only this project's entry, delete the file. If it holds other entries, stop and ask the owner. A hand edit risks `ACCOUNT_INTEGRITY` (`docs/reference/cloud.md:214`). Leaving the credential in place keeps the checkout refused with `INPUT_CONFLICT` (`src/assembly/cloud-binding.ts:48-56`).
3. Revoke the device token by id with the admin `revoke` route (`docs/reference/cloud.md:135`).
4. Do R1, then R0. Lost: nothing. Local still holds every record.

**R3. After cloud writes (step 8 or later).** The cloud now holds changes the local store lacks. Lost if you do nothing: every issue, comment, link, claim and close made in the cloud.

1. Freeze cloud writers: tell sessions to stop, then `forge lane stop --input '{"all":true}'`. That stops dispatch only (Gap 1 applies here too).
2. Take a paged admin dump of the cloud project (`docs/reference/cloud.md:224-225`). Keep it private.
3. Find cloud-only work: issues with an id above the highest local id, and comments, links and status changes on older issues, by comparing the dump with `local-list.json`.
4. Do R2 on every machine, then R1, then R0.
5. Replay the cloud-only work into the local store by hand with `forge issue create`, `comment`, `link`, `update` and `close`. There is no cloud-to-local import (Gap 8). New issues take the next local numbers, which equal the cloud numbers only if you replay in order and the local store made none in between. Check each id.
6. Lost even after replay: cloud event history, lease generations, and request receipts (`docs/reference/cloud.md:276`, `:144`).

If cloud writes were few, prefer to keep the cloud and repair forward. Rollback after heavy cloud use is manual and error prone.

## 6. Gaps

Each row is a place where the code has no command for a step, or differs from the plan. I fixed none of them. The first column is the suggested issue title.

| #   | Suggested issue title                                                                | Evidence                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add a command that freezes or retires the local tracker store                        | The only core store operations are `store.reinit` and `project.init` (`src/core/state/operations.ts:4`, `:13`). `lane.stop` stops lanes only (`src/blocks/work/docs.json:101-104`). An unbound checkout still writes locally (`src/assembly/cloud-binding.ts:48-52`).     |
| 2   | Ship a read-only `forge store export` that writes a backup and `source.json`         | Only `StateOwner.export()` exists in src (`src/core/state/index.ts:2306`). The practice export is a local untracked script with hardcoded paths (`.overseer/tools/practice-export.mjs:5-13`, `:21-28`).                                                                   |
| 3   | Ship a tool that restores converted pages into a cloud project and compares readback | The only sender is a local untracked script with a hardcoded Worker, project pattern and acknowledgement (`.overseer/tools/practice-move.mjs:7`, `:14`, `:21`). `tools/import-current.ts` converts only (`tools/import-current.ts:283-325`).                              |
| 4   | Support or document an incremental local-to-cloud delta for the tracker move         | Restore needs an empty project (`docs/reference/cloud.md:226`). Any local write after the snapshot forces a new project and a full re-import (step 3 of this runbook).                                                                                                    |
| 5   | Admit a cloud project without redeploying the Worker                                 | The Worker serves one project, set by a var (`cloud/src/worker.ts:90`, `:177`; `docs/reference/cloud.md:338`). Switching means a redeploy that cuts off the old project at once.                                                                                          |
| 6   | Add `forge auth logout` (unbind) that removes binding and credential together        | Binding is create-only (`src/assembly/cloud-profile.ts:460-482`). No logout or unbind appears in `src/`. A credential with no binding is refused (`src/assembly/cloud-binding.ts:48-56`).                                                                                 |
| 7   | Add an admin project delete for abandoned cloud projects                             | Only whole-Worker delete exists (`docs/reference/cloud.md:507`). The practice run kept its data for this reason (`.overseer/tools/practice-move.mjs:56`).                                                                                                                 |
| 8   | Add a cloud-to-local export so a rollback can carry back cloud writes                | `tools/import-current.ts:283-325` goes one way. Cloud dump is admin JSON only (`docs/reference/cloud.md:137`, `:224`).                                                                                                                                                    |
| 9   | Fix the cloud reference: lanes are served for bound projects                         | `docs/reference/cloud.md:176` says lanes are not served. Code routes `lane.stop`, `lane.control`, `lane.resume` to the cloud and other lane operations to a coordinator (`src/assembly/cloud-authority.ts:92-95`, `:105`).                                                |
| 10  | Align `lane.resume` docs with the cloud approval shape                               | `src/blocks/work/docs.json:114` says approval takes `{request, quote, source}`. Cloud accepts the request id only (`src/assembly/cloud-authority.ts:137-144`).                                                                                                            |
| 11  | Serve or retire the remaining work operations for cloud-bound projects               | Refused by name: `issue.board`, `call`, `checkpoint`, `resume`, `events`, `tree`, `lint`, `invite`, `join`, `leave`, `attempt.*` (`src/assembly/cloud-authority.ts:75-107`; `src/blocks/work/docs.json:245-405`). Lanes track forge-1248 (`docs/reference/cloud.md:176`). |
| 12  | Add a command that lists live leases before a move                                   | I found no operation that lists live leases. Only `issue.stale` (expired, unreleased) and the left-behind count exist (`src/blocks/work/docs.json:258`, `docs/reference/cloud.md:272`). Absence claim from a name search.                                                 |
| 13  | Decide whether tracker history must move with current state                          | Imported events are fresh revision-1 pairs, not history (`docs/reference/cloud.md:270`). `issue.events` is not served on a bound project (`src/blocks/work/docs.json:314`).                                                                                               |
| 14  | Fix the stale "Forge 0.0.1" text in the cloud-bound write refusal                    | The refusal message names version `0.0.1` while main is `0.1.0-beta.9` (`src/assembly/cloud-authority.ts:56`, `package.json:3`).                                                                                                                                          |
| 15  | Prove whether the restore-time stop blocks `issue.*` writes                          | `docs/reference/cloud.md:49` and `:282` say the stop gates dispatch. I found no statement about issue writes. Step 8 writes before step 11 resumes; the first write tests this.                                                                                           |

Existing issue, not new: device credentials last 30 days and refresh tokens are deferred (`docs/reference/cloud.md:194`, `docs/work/2026-11-10-teams-phase1/plan.md:1`, forge-1125).

## Not verified

- Which build each machine runs now.
- Whether `wrangler rollback` restores var values.
- Whether equal export `sha256` is guaranteed for equal data.
- Whether the all-lanes stop blocks issue writes (Gap 15).
- Anything about the live Worker or the real tracker. No command in this runbook has been run.

## Decisions needed

- **A. Delta policy.** If step 3 finds the local store changed, redo the full import into a new project (default), or add an incremental tool first.
- **B. Retention.** Keep the local store and backup unchanged for 30 days after the switch (default), or a different period.
- **C. Gap order.** Fix Gaps 1, 3 and 6 before the switch (default), or run with the manual procedures above.
