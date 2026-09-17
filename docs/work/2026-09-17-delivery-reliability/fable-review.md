# Preserved Fable review

This is the original completed reviewer output, preserved for provenance. It contains disputed recommendations and unsupported inferences. The reconciled decisions in [review.md](review.md) and [plan.md](plan.md) govern the proposal; this original is not implementation authority. The reviewer wrote this artifact outside the repository, despite its opening claim that nothing was written.

---

# Independent delivery-plan review — 2026-09-17

Planning issue `86c08a2e-7ccc-4da0-8912-1fd4ec5e3495`. Read-only review of the proposed first work wave. Baseline `origin/master` = `bd1abbd8ab63b590fd916dad379e0a575542fcc7`. Nothing was written, run as a test, installed, pushed, or changed in issues. Evidence rungs: R1 said so · R2 pointed at the line · R3 showed the bad case can't happen · R4 ran it · R5 reproduced live.

## Verdict: CHANGES_REQUIRED for the plan as written; narrow GO for two lanes now

The three-lane wave is the right shape. It cannot start as described because (a) the push patch it plans to "recover" no longer merges, (b) its runner detection breaks the stated consumer rule, (c) the CI-propagation lane is blocked by Forge's own protected-state authority, and (d) the freshness conflict needs an explicit amendment before anything beyond the first wave. Two lanes (push parity re-implementation, package-smoke diagnosis) can start immediately under current rules.

## Findings

### F1 — HIGH — Push patch is stale and conflicts; do not recover it as-is (R4)
- `fix/push-resource-aware-docs` head `76a73043` is 17 commits behind `origin/master`; `git merge-tree --write-tree origin/master 76a73043` reports content conflicts in all three touched files: `CHANGELOG.md`, `lib/commands/push.js`, `test/commands/push.test.js`.
- Master changed `push.js` twice since the merge-base (`35a5ebd5` #554 account context, `66b5abb1` #559 bundled workspaces + receipt reuse). The patch predates receipt reuse entirely; its `runTests` change must now sit *after* the receipt check at `push.js:373-380`.
- Change: open a fresh branch from `origin/master`; port the two behaviors (runner routing, `--` delimiter stripping) as new commits, using the patch as a reference diff. Leave the old worktree untouched until the new PR lands.
- Exit: focused `test/commands/push.test.js` green on the new head; no merge conflict against `origin/master` at ship time.

### F2 — HIGH — Patch's runner detection violates the consumer rule (R2)
- Patch `b330cbe7` selects `node scripts/test.js` whenever `<projectRoot>/scripts/test.js` exists. Any consumer repository with a file of that name would have its generic `test` script replaced by a Forge-internal planner.
- Master already has a correct detector at `lib/commands/validate.js:606-607` (manifest `scripts["test:full:parallel"] === "node scripts/test-full-suite.js"` AND the file exists). Reuse that predicate; extract it once into a small shared helper owned by the push lane (single owner rule), fallback remains `<pkgManager> run test`.
- Acceptance mismatch to settle: issue `11e5ef49` names `scripts/test-full-suite.js` (full suite); the patch uses `scripts/test.js` (targeted-or-full planner, same as the pre-push hook at `lefthook.yml:66`). A planner is acceptable as a *push gate* only if it never mints or refreshes a validation receipt and targeted mode is never reported as full-suite proof. State this in the PR.
- Required negative tests: consumer repo with `scripts/test.js` but no manifest marker → package test script runs; Forge repo → planner runs; nonzero planner exit → no push; delimiter cases: no `--` (all args forwarded), `--quick` before `--`, a second `--` after the first preserved for Git.
- Exit: the four negative tests exist and fail without the change (RED shown), pass with it.

### F3 — HIGH — Freshness policy conflict; amendment required, but wave 1 fits both readings (R2)
- Issue `8d51c08b` (open, P1) acceptance 2 and 4 require behind=0 at validate/ship/push and revalidation on base advance. On `origin/master` no such gate exists: `ship.js:120-163` computes `behind` and still returns readiness; `push.js` has no fetch; the codex commit `97736a9d` and `.forge/hooks/check-base-freshness.js` referenced in the issue comments are not on `origin/master` (search over `lib/commands`, `lefthook.yml`, `.forge`, `scripts/branch-protection.js`; absence claim at R2).
- The only *enforced* freshness rule is server-side: branch protection `strict: true` (R4 via `gh api`). Every landing already requires the candidate to be up to date with master and to re-run required checks after the update.
- Proposed amendment (to be posted on `8d51c08b` and accepted by the user before wave 2 or any automation):
  1. behind=0 is required at **dev start** (branch from freshly fetched `origin/master`) and at **ship/push of the selected landing candidate**.
  2. `validate` records the fetched base SHA in its evidence; a base advance marks a receipt *base-stale* but does not force a rebase of non-candidates. The candidate's mandatory update changes HEAD, which already invalidates the receipt (`validation-receipt.js:80-88`), so acceptance 4 holds for the only branch that lands.
  3. No blanket sibling updates; the PR Monitor BEHIND auto-update path stays opt-in/off.
- Wave 1 under current rules: three lanes each branched from fresh `origin/master` (behind=0 at dev), landed one at a time, each updated and revalidated at its own landing. This satisfies both the issue's reading and the plan's; worst case two extra full validations. Proceed; do not treat the amendment as accepted.

### F4 — HIGH (blocker for the CI lane) — `test.yml` has no Forge-owned general writer (R2)
- `.github/workflows/**` and `.forge/hooks` are the protected `workflows` surface (`lib/protected-state-surfaces.js:125-128`). `owningWriter` (`lib/protected-state-authority.js:41-70`) grants `test.yml` only to `forge release update-bun-pins` (pin lines). Removing `|| true` at `test.yml:398` is not a pin edit, so the pre-commit `protected-state` job (`lefthook.yml:32-35`) rejects an agent commit. Issue `4aed2cc8` comment of 2026-09-11 recorded exactly this block.
- Recent `test.yml` commits are all squash merges by the human maintainer. Change: before starting the lane, confirm the human-commit path with `node scripts/protected-state-check.js` on a staged one-line edit; if it is rejected, the lane is blocked until a content-bound workflow writer exists (that is new authority work, out of wave scope). No hook bypass.
- Replacement for `|| true`: keep the existing `if: steps.affected.outputs.run_test_env == 'true'` as the explicit no-work path; run the node test command without `|| true`; write the result to `test-results/` and assert tests>0 in the existing profile step so a zero-match glob cannot pass silently.
- Exit (R5): throwaway PR with a deliberately failing `test-env` test → `Targeted PR Tests (windows-node22|ubuntu-node24)` red → `CI Gate` red; revert the injected failure → green. Required contexts unchanged (`CodeQL`, `ESLint`, `Analyze (javascript-typescript)`, `Run eslint scanning`, `Analyze (actions)`, `CI Gate`).

### F5 — MEDIUM — Package smoke: smallest investigation, and it gates only OS-sensitive PRs (R2, inference marked)
- `test/integration/standalone-package-smoke.test.js:104-131`: the 60 s test budget covers `npm pack` + `npm install --ignore-scripts <tarball>` + `forge --version` + `git init` + `forge setup --quick --yes`. Issue `48386b65` says install was killed at ~60.1 s, so install alone consumes the budget. The `npm(...)` helper passes `process.env` (plus audit/fund off), not the isolated env; on a fresh hosted runner the npm cache is cold every run (inference: dependency-tree download + NTFS extraction is the dominant phase). The test is `forge-test-resource: exclusive`, so lane overlap is not the first suspect.
- Smallest step (test file only, no threshold change, no workflow edit): add per-step elapsed to each `expect` failure message; run the install with `--timing` and `npm_config_logs_dir` inside the temp dir; on failure print the last timing lines. Run 3× on hosted windows-node22 from a branch that touches an OS-sensitive path, or reproduce locally with Node 22 + npm `--timing`. Compare against tarball `fileCount`/`unpackedSize` from `npm pack --json` and the runtime dependency count.
- Landing implication: `changes.os_sensitive` (`test.yml:82`) includes `test.yml` and `package.json` but **not** `lib/commands/push.js`. So the CI-propagation PR runs the full matrix (exposed to the smoke flake); the push-parity PR does not. Land push parity first; land the `test.yml` change after the smoke root cause is measured or the smoke is fixed.
- Exit: one named phase with a measured share of the 60 s on hosted Windows Node 22; fix is structural (fewer/bundled deps, warm cache, or a faster install path), and the unchanged 60 s assertion passes 3/3 on the merged artifact.

### F6 — MEDIUM — Budget lane is real but belongs to wave 2 (R2)
- `scripts/test-full-suite.js:530-534`: `Math.max(1, …)` for the strongest lane grants cost 2 against a Windows budget of 1. `lib/commands/validate.js:687` invokes the runner with no `--shards`; `FORGE_TEST_WORKERS` does not exist (R2: only `--shards` at `:67` and `FORGE_TEST_NODE_EXECUTABLE` at `:983`).
- Change: pure-function regression (budget 1, win32 cost 2) → reject or normalize with a visible effective bound; add one validated passthrough from `forge validate` to the runner; record the effective budget in run evidence, **not** in the receipt identity (budget does not change coverage; changing the receipt schema forces a `SCHEMA_VERSION` bump).
- Order: after push parity lands (both lanes touch `scripts/test*.js`/`validate.js` neighbourhood).

### F7 — LOW — Receipt reuse integrity is sound for the wave; note two boundaries (R2)
- Receipt binds worktree scope, exact HEAD, clean tree (untracked included), runtime, Bun/Node identities, runner id, one-hour TTL, HMAC key in `~/.forge` (`validation-receipt.js:37-88, 169-180`); only complete full-suite success can mint (`:90-102`); reuse happens only inside `forge push` after branch protection and lint (`push.js:356-380`). Lockfile/config changes are covered by HEAD+clean.
- Boundaries: (1) base SHA is not bound (F3 covers it); (2) the push lane must not touch receipt code, and its new `runTests` path must run only when `receipt.valid !== true`.

### F8 — LOW — Comment/protection drift (R4)
- `test.yml:268-274` says Cross-OS Gate should be the required context; live protection requires `CI Gate`, which `needs` `cross-os-gate`, so coverage holds. Fix the comment when `test.yml` is next legitimately edited; no protection change.

## Graft pilot: defer
Wave 1's blockers are authority, policy, and one unexplained hosted timeout, none of which is exploration cost. Graft's setup edits repo files (`.gitignore`, agent hooks) that collide with this repo's protected-state and drift gates, and the 20% criterion needs a controlled A/B that costs more than the wave itself. Revisit after wave 1 lands, in a pinned disposable clone outside the repo, structural mode, telemetry off, five fixed questions, build/refresh overhead counted. Not alongside.

## Windows/Linux measurement
No wave-1 dependency except the smoke repro on hosted Windows Node 22. Keep the prior analysis split (native Windows owns Windows guarantees; Linux pilot deferred). Do not compare suite timings until the Bun 1.4.2 baseline replaces the 1.3.12 figure.

## Dependency order and exit conditions
| Step | Work | Depends on | Exit |
|---|---|---|---|
| 0 | Human: post amendment text on `8d51c08b`; confirm human commit path for `test.yml` | none | comment posted; `protected-state-check` result recorded |
| 1a | Push parity re-implemented from `origin/master` (F1, F2, F7) | none | negative tests RED→GREEN; lands with `CI Gate` green, no full matrix needed |
| 1b | Smoke diagnosis (F5) | none | measured phase; structural fix; 3/3 on merged artifact |
| 1c | `test.yml` fail-closed (F4) | 0 (writer path), preferably 1b | R5 red/green proof on throwaway PR |
| 2 | Budget passthrough (F6) | 1a landed | pure-function test; effective budget in evidence |
| 3 | Shadow risk selection, consolidation | amendment accepted; 1a–2 landed | out of this review |

## What actually blocks implementation today
1. No Forge-owned writer for a general `test.yml` edit (F4).
2. Freshness amendment not yet proposed or accepted (F3) — blocks wave 2+, not wave 1.
3. Smoke root cause unknown → every OS-sensitive PR is exposed (F5).
4. The push patch must be re-done, not recovered (F1/F2) — work, not a blocker.
5. Live CI refresh from the separate reader is still pending; this review did not sample runs.

A planning review cannot prove the 5–10 PR/day target or certify unrun behaviour; all "exit" rows above are R4/R5 work still to be done.
