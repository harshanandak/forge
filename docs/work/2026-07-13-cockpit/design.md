# Workflow customization cockpit — Tier-1 read view + copy-as-command

Issue: `84970f9d-878c-4577-9000-adbceefc0128` · Epic: `363954dd-f6e1-4463-870c-c020c06db2aa`

## Intent

Turn the read-only Forge dashboard (a static `file://` SPA — no server) into a
**customization cockpit** that SHOWS the configurable workflow architecture and
lets users copy the exact `forge …` command to change it. Because there is no
server, "customize" in Tier-1 = **copy-as-command**. The Tier-2 write path
(`forge serve` config-intent) is filed separately (`9f2f0320`) and drops into the
same `DataSource` seam without render changes.

## Design (3 parts)

### 1. Snapshot bake (`web/dashboard/generate-snapshot.mjs`)

Add a point-in-time `snapshot.workflow` object, sourced from `lib/` via
`createRequire` (the generator is ESM), degrading to `null` under `tryRun` if a
module fails to load:

- **Resolved runtime graph** (`getResolvedRuntimeGraph`): `phases`, `roles`,
  `gates`, `rails`, `evidence`, `artifacts`, `adapters`, `actions`, `edges`,
  `planSubSkills` (`graph.planning.subSkills` — the 5 `/plan` sub-skills), and
  `config` (`.forge/config.yaml` load state).
- **`stageOrder` / `roleIds`** = `[...ROLE_IDS]` (`plan,dev,validate,ship,review,verify`)
  — the fixed, closed role set and the canonical 6-stage rail order.
- **Raw config** via `loadRawConfig(ROOT)` → `rawConfig` (`null` + `configPresent:false`
  when `.forge/config.yaml` is absent → "all defaults").
- **PROFILES** imported from `lib/workflow-profiles.js` (6 profiles × stages +
  classification keywords).
- **Skills catalog**: walk `skillSearchDirs(ROOT)` precedence (`.skills` > `skills`
  > packaged), first hit wins; attach `skills-lock.json` `source`/`sourceType`/`hash`
  per skill; bake the per-harness render matrix `SESSION_START_SUPPORT` from
  `hook-renderer.js` (only Claude has SessionStart injection — honest).
- **Lint** via `lintRuntimeGraphConfig` → `{ok, errors, warnings}` (surface
  unknown-key warnings).
- **seams**: review/verify phase gap, PROFILES-edit (`8e7e5ad6`), Tier-2 write
  (`9f2f0320`), comment-back (`e244f12d`).

### 2. Cockpit view (`web/dashboard/app.js`)

A new top-level **Workflow** view in `VIEWS`, matching the existing mono /
Swiss-brutalist dark-default skin and a11y patterns (`data-act` delegation,
`esc`, `icon()`, `seamId()`), rendering:

- **Stage rail** — 6 cards from `stageOrder`, each joining its `role → skill`
  binding and (where a phase record exists) its gates, evidence, artifacts, and —
  for `plan` — its 5 sub-skills. review/verify show the role binding + an explicit
  SEAM note (no phase record yet).
- **Gates panel** — 4 stage gates + 3 human gates (intent / plan-approval /
  merge) + `gate.issue_verify`, each with enabled / **LOCKED** state (locked =
  greyed + why, mirroring `gate.js` `Cannot disable locked gate`; never rendered
  as toggleable). **Rails** shown separately (all locked except
  `rail.kernel_tracking`).
- **Skills catalog** — which copy wins (user `.skills` > project `skills` >
  packaged), lock hash/source, and the per-harness render matrix.
- **Profiles × stage + keyword matrix** — marked read-only / SEAM (config can't
  edit profiles yet).
- **Honesty badges** on every item: `configSource` package-default vs override →
  `customized` badge; lint warnings surfaced; fixed things (closed `ROLE_IDS`,
  stage list, locked rails) labelled `fixed`.

### 3. Copy-as-command

On every CONFIGURABLE item, render the exact command string with a copy button —
the Tier-1 write path:

- unlocked gate → `forge gate disable <id>` / `forge gate enable <id>`
- role → skill binding → `forge role <stage> --use <skill>`

Copy uses `navigator.clipboard` with a `document.execCommand('copy')` fallback for
`file://`. Locked gates and rails render NO command (they are fixed). Everything
flows through the existing `DataSource` seam so the Tier-2 server drops in later
without touching render code.

## Honest SEAMs (data the graph does not expose — surfaced, not faked)

- **review / verify have no phase record.** The runtime graph exposes `phases`
  only for `plan/dev/validate/ship` (4), but `ROLE_IDS` has 6. review/verify are
  rendered from their `role → skill` binding with an explicit "no runtime phase
  yet" note — their gates/evidence are not invented.
- **PROFILES are read-only** (`8e7e5ad6`) — no config surface edits them yet.
- **Tier-1 has no write endpoint** — copy-as-command only; Tier-2 = `9f2f0320`.

## Verification

- Regenerate the snapshot; assert `data.json` has `workflow` with all baked
  fields; `node --check web/dashboard/app.js`.
- `bun test web/dashboard/app.test.js` — new tests for the pure cockpit helpers
  and the snapshot integrity of `workflow`.
- `eslint . --max-warnings 0`; sonarjs cognitive-complexity < 15 (view split into
  small pure helpers).
