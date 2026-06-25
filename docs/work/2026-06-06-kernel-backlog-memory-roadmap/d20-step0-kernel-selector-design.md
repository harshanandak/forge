# D20 Step 0 + Step 1 — Kernel-CLI Selector + First Safe `bd` Call-Site Slice

**Status:** Design + TDD task list (no code). Scope-bounded per the D20 entry-point brief.
**Date:** 2026-06-22
**Owner work folder:** `docs/work/2026-06-06-kernel-backlog-memory-roadmap/`

---

## 0. Problem (verified against code)

The kernel issue backend is selected only by `shouldUseKernelBroker(opts)`:

- `lib/commands/_issue.js:170` → `opts.useKernelBroker || opts.kernelBroker || opts.issueBackend === 'kernel'`
- `lib/forge-issues.js:298` → same predicate on `deps`.

These are set **only in tests** (`test/commands/_issue.test.js:275`, `test/forge-issues.test.js`). There is **no CLI flag, no env var, no config** that sets them. `FORGE_ISSUE_BACKEND` does not exist anywhere in `lib/`, `bin/`, or `test/` (grep-verified). Consequence: the kernel backend is unreachable from the CLI → `bd` issue-CRUD call-sites can't be removed, and `kap-10/11/12` are stranded in `.git/forge/kernel.sqlite` with no way to close them.

### The real seam (critical, verified)

`bin/forge.js:4196` calls `executeCommand(registry.commands, command, args.slice(1), flags, projectRoot, { enforceStage })`. But `lib/commands/_registry.js:164` invokes the handler as:

```js
return await command.handler(args, flags, projectRoot);   // _registry.js:164 — only 3 args
```

The issue handlers (`_issue.js:246`, `:257`) declare a **4th `opts` parameter** that `shouldUseKernelBroker(opts)` reads — but `executeCommand` **never passes it**. So the selector cannot work until `executeCommand → command.handler` threads a resolved `opts`/`deps` object. **This is the enabler edit.**

**Dispatch path confirmed (verified, not inferred):** `forge close` is a discovered alias. `_registry.js:72` skips `_`-prefixed files, but the public wrappers `lib/commands/{close,create,update,list,show,claim,release,comment,ready}.js` each do `module.exports = makeAliasCommand('<verb>')` and are discovered + registered via `commands.set(mod.name, mod)` (`_registry.js:99`). Their `handler` (built by `makeAliasCommand`, `_issue.js:246`) is invoked through the same `executeCommand` 3-arg site at `_registry.js:164`. So `forge close → discovered alias → executeCommand → 3-arg handler` — T2/T6 target the correct seam. **Note:** `release.js` wraps the alias with extra logic (`release.js:14`); T2's 4th-arg addition is additive/backward-compatible, so the wrapper is unaffected.

---

## 1. Three additional blockers between "selector resolves" and "`forge close kap-10 kap-11 kap-12 --kernel` works" (all verified)

| # | Blocker | Evidence | Fix location |
|---|---------|----------|--------------|
| B1 | **No real driver on CLI path.** `createKernelIssueBackend` (forge-issues.js:283) defaults broker `driver` to `deps.kernelDriver`, which is `undefined` from CLI → first guarded op hits `requireGuardedDriverMethods(undefined)` → throws `"driver must provide exec()"`. | forge-issues.js:283–296; broker.js:643 | Construct `createBuiltinSQLiteDriver({ databasePath })` (sqlite-driver.js:1169) and inject as `kernelDriver`/broker. |
| B2 | **Migrations never run on runtime path.** `driver-smoke.test.js:64` comment: "the public entry point never initializes the broker." Nothing calls `broker.initialize()` → pragmas (WAL/busy_timeout/FK) + migration DDL never applied for a fresh connection. | broker.js:724; driver-smoke.test.js:43,64 | CLI kernel path runs `broker.initialize()` (migrations are idempotent — `execMigrationStatement` swallows duplicate-column). Decide per-invocation vs lazy (see §5). |
| B3 | **Result-envelope mismatch — success reads as failure.** Kernel mutations return `{ ok:true, schema_version, command, data, next_commands }` (broker.js:545, `okMutationResponse`) with **no `success` field**. `bin/forge.js:4202` checks `if (result && !result.success)` → a successful kernel close exits 1. Beads path returns `{ success:true, output }`, so only the kernel branch breaks. | broker.js:545–553; bin/forge.js:4202–4214 | Normalization shim mapping `ok→success`, rendering `data` as `output`, preserving `next_commands`/`schema_version` for `--json`. |
| B4 | **The literal task command is broken in the broker.** (a) `buildIssueMutationEvent` uses `firstPositionalArg` (broker.js:517) → `forge close kap-10 kap-11 kap-12` closes **only kap-10**. (b) `buildUpdatePayload` (broker.js:405) never reads `reason` → `--reason=...` is **silently dropped**. | broker.js:405,517 | Multi-id iteration + `reason` passthrough (own tasks; do NOT let a green single-id `runIssueOperation` unit test hide this). |

**Config:** `.forge/config.yaml` is already read via `lib/core/runtime-graph.js` (`readConfigSection`, line 504). `.forgerc.json` is docs-only (`agents-config.js`). So a config knob has a real home but is **optional/deferred** — **flag + env are the load-bearing requirement.**

---

## 2. Design

### 2.1 Selector module (new owned file)

As landed, the selector splits across two files: the pure backend resolver
`lib/issue-backend.js` (`resolveIssueBackend`) and the CLI dispatch glue
`lib/commands/_resolve-command-opts.js` (strips the selector tokens, calls the
resolver, and assembles the kernel deps). Neither does I/O beyond reading a
passed-in env/flags/config snapshot, keeping the `bin/forge.js` edit minimal (the
D19 coordination point).

```
resolveIssueBackend({ flags, env, config }) -> {
  issueBackend: 'kernel' | 'beads',
  useKernelBroker: boolean,        // convenience mirror, === (issueBackend==='kernel')
  source: 'flag' | 'env' | 'config' | 'default'
}
```

**Precedence (highest first):**

1. **Flag** — `--kernel` (boolean) OR `--issue-backend kernel|beads`. `--kernel` is sugar for `--issue-backend kernel`. Mutually-exclusive conflict (`--kernel` + `--issue-backend beads`) → explicit error.
2. **Env** — `FORGE_ISSUE_BACKEND=kernel|beads`. Unknown value → error listing valid values (never silently default; matches JSON-first explicitness).
3. **Config** — `.forge/config.yaml` key `issueBackend: kernel|beads` (OPTIONAL — see Task 8; if config loading isn't trivially reachable, ship flag+env and defer config).
4. **Default** — `beads` (preserves today's behavior; kernel is strictly opt-in).

Output threads into the existing predicate unchanged: set `opts.issueBackend` (and mirror `useKernelBroker`) so both `_issue.js:170` and `forge-issues.js:298` light up with **zero change to the predicates themselves**.

### 2.2 Threading opts through the registry (the enabler)

- `lib/commands/_registry.js`: extend `executeCommand` to forward an `opts`/`deps` object as the handler's 4th arg: `command.handler(args, flags, projectRoot, options.commandOpts ?? {})`. Backward-compatible — existing handlers ignore the 4th arg.
- `bin/forge.js`: at the dispatch site (4196), call `resolveIssueBackend({ flags, env: process.env, config })`, build the kernel `deps` (driver + flag), and pass as `commandOpts`. **Only the issue/alias commands need it**; pass it for all (harmless) or gate to the issue command set.

### 2.3 Kernel deps assembly (B1 + B2) — new owned file

`lib/kernel/cli-broker-factory.js`:

```
buildKernelIssueDeps({ projectRoot, databasePath? }) -> {
  useKernelBroker: true,
  kernelDriver: createBuiltinSQLiteDriver({ databasePath }),  // sqlite-driver.js
  // broker constructed by createKernelIssueBackend using kernelDriver
}
ensureKernelMigrated(broker)  // idempotent broker.initialize() wrapper
```

`forge-issues.js:285` already accepts `deps.kernelDriver`, `deps.kernelDatabasePath`, `deps.createKernelBroker` — so this factory plugs in with **no change to `createKernelIssueBackend`'s contract**. The factory owns: runtime detection fallthrough (bun:sqlite→node:sqlite→error, already in `selectBuiltinSQLiteRuntime`), D19 filesystem-doctor hook point (read-only check before placing DB — coordinate, don't reimplement), and `initialize()`.

### 2.4 Result normalization shim (B3) — `lib/commands/_issue.js`

Wrap the kernel branch return in `runIssueSubcommand` so the dispatcher sees a uniform shape:

```
normalizeIssueResult(raw) ->
  raw.ok !== undefined
    ? { success: raw.ok, output: render(raw), error: raw.ok ? undefined : raw.error?.message,
        _envelope: raw }   // keep schema_version + next_commands for --json
    : raw                  // beads path already { success, output }
```

`render(raw)` prints `data` (human) or the full envelope (when `--json`). **Must not drop `next_commands`/`schema_version`** (contract requirement).

### 2.5 Multi-id + reason (B4) — kernel branch only

**Multi-id — scope to the kernel branch (verified nuance).** Beads already fans out: `close` is a WRITE op → `runIssueOperation('close', [id1,id2,id3])` → `bd close <all ids>` (bd does the fan-out). **Only the kernel path single-ids** via `firstPositionalArg` (broker.js:517). So the per-id loop must be **gated to `shouldUseKernelBroker(opts)`** — looping unconditionally would change beads from one `bd` spawn to N spawns (regression). Implement the loop at the `_issue.js` layer (loop `runIssueOperation` per id under the kernel branch, aggregate envelopes; success iff all succeed, else per-id errors). This keeps broker single-event semantics intact.

**Reason — `--reason` is dropped by `buildUpdatePayload` at `broker.js:405` (NOT `_issue.js`).** Two options, **chosen: extend `buildUpdatePayload` (broker.js) to read `reason`** into the close payload, matching beads `close --reason` semantics. This means **T4 also owns `lib/kernel/broker.js`** (the `buildUpdatePayload`/close-payload region) — see updated ownership map. (Alternative considered: a second `runIssueOperation('comment',...)` carrying the reason, which stays inside `_issue.js`; rejected because it splits one logical close into two events.) **Ambiguity ≥80%** — beads `close --reason` is the reference; proceed.

### 2.6 How `kap-10/11/12` get closed (end-to-end, once the above lands)

```
forge close kap-10 kap-11 kap-12 --reason="..." --kernel
  → bin/forge.js resolveIssueBackend(flag) → issueBackend='kernel'
  → executeCommand forwards commandOpts (driver + flag) to alias handler
  → _issue.js runIssueSubcommand: WRITE op → runIssueOperation('close', ...)
  → forge-issues.js shouldUseKernelBroker(deps)=true → createKernelIssueBackend(driver injected)
  → ensureKernelMigrated → broker.runIssueOperation('close', [id], ...) per id
  → guarded event issue.close on .git/forge/kernel.sqlite, reason in payload
  → normalizeIssueResult → {success:true} per id → dispatcher prints, exit 0
```

### 2.7 First safe `bd` call-site slice (Step 1)

**Selection rule (state to all implementers):** Step 1 makes the issue-CRUD path *kernel-routable and tested*. It **does NOT delete** the `bd` passthrough (parity-gated, D14) and **does NOT** drop `.beads` reads. Beads stays the default.

From the kill-list, the FIRST tranche — sites that become kernel-routable purely by the selector, no Dolt lifecycle touched:

- `lib/commands/_issue.js` (12 sites, lines 9–225) — the alias/issue command surface. **Routable now**: every write op already calls `runIssueOperation` which honors `shouldUseKernelBroker`. The remaining `bd`-literal strings are help text/usage; the live `exec('bd', ...)` at :225 is the beads-default branch and **stays** (parity), but is now bypassed under `--kernel`.
- `lib/forge-issues.js` (4 sites, lines 74–112) — `bd` command-candidate resolution; **stays** as the beads-default executor, gated behind `shouldUseKernelBroker` false. No deletion; covered by the selector routing it around.

**Net Step-1 deliverable:** the 8 issue verbs (`create/update/close/list/show/search/stats/claim/release/comment/dep`) reach the kernel broker under selector, with the beads path untouched as default. No kill-list checkbox is *deleted*; the issue-CRUD entries become "kernel-routable, beads-default" — the precondition every later deletion depends on.

**Explicitly OUT (flag as blocked/deferred):** `lib/commands/sync.js` (9 — dolt pull/push), `lib/commands/worktree.js` (15 — dolt server lifecycle). Those are the D14 authority flip. See §4.

---

## 3. TDD Task List (parallel waves, RED→GREEN→REFACTOR)

**Conventions (apply to every task):** TDD RED→GREEN→REFACTOR. ESLint `--max-warnings 0`, unused params `_`-prefixed. `bun test` with **explicit per-test timeout (3rd arg)** — bunfig `[test]` timeout is NOT honored. Use `forge test` / `forge push`. JSON-first envelope: never drop `next_commands`/`schema_version`. Windows/Git Bash. Ambiguity: 7-dim rubric, ≥80% proceed+document, <80% flag.

### Dependency graph

```
Wave 1 (parallel, independent files):
  T1 selector module        ─┐
  T3 normalization shim      ─┤
  T5 cli-broker-factory      ─┤   (all leaf, no shared files)
  T8 config knob (optional)  ─┘
        │            │            │
Wave 2 (depends on Wave 1):
  T2 registry opts-threading  ← needs T1 contract
  T4 multi-id + reason        ← independent of T2, but shares _issue.js with T3 → sequence after T3
        │
Wave 3 (integration, depends on 1+2):
  T6 bin/forge.js wiring      ← needs T1,T2,T5 (D19 COORDINATION POINT)
  T7 e2e kap-close test       ← needs all
```

### File ownership (collision map)

| Task | Owns (writes) | Reads only |
|------|---------------|-----------|
| T1 | `lib/issue-backend-selector.js` + its test | — |
| T2 | `lib/commands/_registry.js` + test | `_issue.js` |
| T3 | `lib/commands/_issue.js` (normalize fn region) + test | broker envelope |
| T4 | `lib/commands/_issue.js` (multi-id loop region, kernel-gated) **+ `lib/kernel/broker.js` (`buildUpdatePayload`/close-payload region, ~line 405)** + tests | sqlite-driver |
| T5 | `lib/kernel/cli-broker-factory.js` + test | sqlite-driver, broker, forge-issues |
| T6 | `bin/forge.js` (dispatch region ~4196) | T1,T5 |
| T7 | `test/e2e/kernel-issue-cli.test.js` (new) | all |
| T8 | `lib/issue-backend-selector.js` config branch (sequence AFTER T1) | runtime-graph |

> **T3 and T4 both edit `_issue.js`** — sequence them (T3 first, then T4) or split into disjoint regions with a merge owner. Do **not** run in parallel. **T4 additionally owns `lib/kernel/broker.js`** (`buildUpdatePayload`, ~line 405) for the `--reason` passthrough — no collision with T3/T5 (they only *read* broker.js), but T4's broker edit must land in the same PR as its `_issue.js` loop edit.

---

### T1 — Selector module `lib/issue-backend-selector.js`
- **RED:** test `resolveIssueBackend` precedence: flag>env>config>default; `--kernel`↔`--issue-backend kernel` equivalence; conflict error; unknown env value error; default=`beads`; output mirrors `useKernelBroker`.
- **GREEN:** pure function, no I/O.
- **REFACTOR:** extract valid-value constants; share with `_issue.js`/`forge-issues.js` predicate keys.

### T2 — Registry opts threading `lib/commands/_registry.js`
- **RED:** test `executeCommand` forwards a 4th arg to `command.handler`; existing 3-arg handlers unaffected (backward-compat).
- **GREEN:** `command.handler(args, flags, projectRoot, options.commandOpts ?? {})`.
- **REFACTOR:** none beyond naming. **Dep:** T1 (opts shape).

### T3 — Result normalization shim `lib/commands/_issue.js`
- **RED:** kernel `{ok:true,data,next_commands,schema_version}` → `{success:true, output, _envelope}`; `ok:false` → `{success:false,error}`; beads `{success,output}` passes through unchanged; `--json` preserves `next_commands`+`schema_version`.
- **GREEN:** `normalizeIssueResult` wrapping the kernel branch return.
- **REFACTOR:** centralize render.

### T4 — Multi-id close + `--reason` — `_issue.js` (kernel-gated loop) + `broker.js` (reason) (AFTER T3)
- **RED:** under kernel backend, `forge close a b c --reason=x` issues 3 kernel closes; reason reaches the close payload; aggregate success iff all succeed; partial-failure surfaces per-id errors. **Plus a beads-branch regression guard:** beads `close a b c` still results in ONE `bd close` spawn (loop must NOT apply to beads). (Guards broker `firstPositionalArg` single-id trap, broker.js:517, and dropped reason, broker.js:405.)
- **GREEN:** kernel-gated per-id loop at `_issue.js` (only when `shouldUseKernelBroker(opts)`); extend `buildUpdatePayload` (broker.js:405) to read `reason`.
- **REFACTOR:** share the kernel loop with other multi-id verbs (update) without touching the beads passthrough.

### T5 — CLI broker factory `lib/kernel/cli-broker-factory.js`
- **RED:** `buildKernelIssueDeps` returns `{useKernelBroker:true, kernelDriver}`; driver built from `createBuiltinSQLiteDriver`; `ensureKernelMigrated` is idempotent (double-call safe, swallows duplicate-column); runtime-absent → clear error. Mock the sqlite runtime in tests; **explicit per-test timeout**.
- **GREEN:** thin factory over sqlite-driver + `broker.initialize()`.
- **REFACTOR:** expose D19 filesystem-doctor hook seam (call-out, not impl).

### T6 — `bin/forge.js` wiring (D19 COORDINATION POINT)
- **RED:** integration test (spawn or in-proc) — `--kernel` routes to kernel broker (assert via injected driver/db path); env `FORGE_ISSUE_BACKEND=kernel` same; default → beads path unchanged.
- **GREEN:** at dispatch (~4196): `resolveIssueBackend` + `buildKernelIssueDeps` when kernel → pass as `commandOpts`.
- **REFACTOR:** keep edit minimal.
- **⚠️ D19 COORDINATION:** a parallel D19 track (filesystem doctor) also edits `bin/forge.js` and "command handlers" (tasks.md:57). **Coordinate the same dispatch region.** Agree merge order with D19 owner BEFORE editing; prefer landing the selector seam first (smaller), or have one owner stage both edits. Flag in PR description.

### T7 — E2E kap-close `test/e2e/kernel-issue-cli.test.js`
- **RED:** against a temp `.git/forge/kernel.sqlite` seeded with 3 open issues, `forge close <3 ids> --reason --kernel` closes all 3, exit 0, envelope preserved. Mirrors the real kap-10/11/12 close. **Explicit per-test timeout.**
- **GREEN:** passes once T1–T6 land.
- **REFACTOR:** factor a kernel-CLI test harness helper.

### T8 — Config knob (OPTIONAL / lower priority) `lib/issue-backend-selector.js`
- Only if `.forge/config.yaml` `issueBackend` is trivially reachable via existing `runtime-graph` reader. **RED:** config sets backend when flag+env absent; flag/env still override. **If not trivial → defer; do NOT build a new config system (scope creep).**

---

## 4. Blocked / Deferred (needs D14 Dolt flip first)

| Item | Kill-list sites | Why blocked |
|------|-----------------|-------------|
| Remove `lib/commands/sync.js` dolt pull/push | sync.js (9) | D14 authority flip — Dolt sync lifecycle. OUT of D20 Step 0/1. |
| Remove `lib/commands/worktree.js` dolt server lifecycle | worktree.js (15) | D14 — Dolt server start/stop per worktree. OUT. |
| **Delete** (not route) the `bd` issue-CRUD passthrough | _issue.js:225, forge-issues.js:74–112 | Parity-gated (D22) + projection-gated (D16). Selector *routes around* it; deletion waits for parity gate. |
| Move `insights.js`/`recap` `.beads/*.jsonl` reads to kernel | insights.js (7), recap | D16 projection must be the read source first. |
| Setup/preflight/smart-status `bd` retraining | setup.js (32), preflight.sh (16), smart-status.sh (16) | Later kill-list tranche (ecosystem retraining), after authority flip. |

---

## 5. Open decision (does not block design viability)

**`initialize()` timing:** per-invocation (run `ensureKernelMigrated` on every kernel CLI call — simple, idempotent, ~1 extra DDL no-op pass) **vs** lazy/cached (memoize "migrated" per process). **Recommendation:** per-invocation for the CLI (process is short-lived; migrations are idempotent via `execMigrationStatement`). Document the choice in T5; it changes T5's test, not the design.

## 6. Ambiguity scoring (<80% flags)

- Close `--reason` storage field (payload column vs close-comment): **≥80%** — beads `close --reason` is the reference; proceed, document field.
- Config knob existence: resolved — `.forge/config.yaml` reader exists; knob is optional, **flag+env load-bearing**. No flag needed.
- D19 `bin/forge.js` overlap: **flagged** — cross-track coordination required (T6); not an ambiguity in design, a merge-sequencing risk.
