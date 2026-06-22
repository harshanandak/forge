# D19 — Filesystem Doctor (default-on gate): Design + TDD Task List

**Status:** Design (no code). Hand-off artifact for parallel implementer agents.
**Authority:** `decisions.md` §D19. **Scope discipline:** doctor *reports the filesystem class only*; broad health stays in `runtime-health.js` (do not balloon doctor).

---

## 0. Verified facts (load-bearing, read from source)

| # | Claim | Evidence |
|---|-------|----------|
| F1 | **SQLite file creation is LAZY.** The injected driver opens/creates the DB on the **first `exec`/query**, not at construction. `lib/kernel/sqlite-driver.js`: `getDatabase(config)` (~L879) calls `createDatabase` → `new Database(databasePath,{create:true})` (~L97) only on first use. `createDriver` itself opens nothing. | sqlite-driver.js L84-100, L879-884 |
| F2 | **The first disk touch is `broker.initialize()`.** It runs `await driver.exec(<pragma>)` in a loop, then migrations. The gate at the **top of `initialize()`, before the pragma loop**, fires *before* `kernel.sqlite` exists. | broker.js `initialize()` |
| F3 | **`doctor.js` requires ZERO `bin/forge.js` edit.** `bin/forge.js` L4165 `loadCommands(lib/commands)` auto-discovers every non-`_` `.js` file; L4187 `if (registry.commands.has(command)) { … return; }` short-circuits **before** the `command==='setup'` else-if chain. Help (L2780) is registry-driven. Dropping `lib/commands/doctor.js` registers + routes + helps it automatically. **This dissolves the D20 collision warned about in the task.** | _registry.js `loadCommands`; bin/forge.js L4165-4187 |
| F4 | Command module contract: `{ name:string, description:string, usage?:string, handler(args, flags, projectRoot) }` returning `{ success, output?, error? }`. `bin/forge.js` writes `result.output` to stdout, `result.error` to stderr + exit 1. | _registry.js `validateCommand`/`executeCommand`; orient.js, recap.js |
| F5 | Real broker wiring is `lib/forge-issues.js` L285 `createKernelBroker = … createLocalBroker({…})` — the only production call site; broker tests inject fakes. The gate lives **inside** `initialize()` so it covers both paths without touching forge-issues.js. | forge-issues.js L10, L285 |
| F6 | Test convention: `bun:test` (`describe/expect/test`), tests mirror lib path under `test/` (e.g. `test/kernel/broker.test.js`, `test/commands/orient.test.js`), deps injected via `options`. | broker.test.js header |

---

## 1. Design

### 1.1 Filesystem-class detector (foundational, pure + thin I/O shell)

**Module:** `lib/kernel/fs-class.js`. Two layers — the split is the testability crux.

#### Layer A — pure classifier (100% synthetic-tested, zero I/O)
```
classifyFromSignals(signals) -> Classification
```
`signals` (plain object, fully injected):
```
{
  platform:   'win32' | 'darwin' | 'linux',
  absPath:    string,              // normalized absolute DB path
  env:        { OneDrive, OneDriveConsumer, OneDriveCommercial, ICLOUD?, ... },
  homedir:    string,
  isUNC:      boolean,             // path starts with \\ or //
  driveType:  'fixed'|'network'|'removable'|'unknown'|null,  // Windows, from probe
  mountFsType:string|null,         // Linux, fs type at the mount covering absPath (drvfs/9p/cifs/nfs/fuse.*)
  isWslInterop: boolean           // running under WSL (probe of /proc/version)
}
```
`Classification` (the canonical return shape, reused by doctor + gate):
```
{
  class:        'local-ok'|'onedrive'|'dropbox'|'gdrive'|'icloud'
                |'network-unc'|'mapped-network-drive'|'wsl-cross'|'unknown',
  riskTier:     'safe'|'warn'|'refuse',
  signal:       string,            // the matched signal, e.g. 'env.OneDriveCommercial prefix'
  remediationKey: string           // stable key → message table (1.4)
}
```

**Detection signals per OS** (dependency-free; precedence = most-corrupting first):

- **Windows (`win32`)**
  - `network-unc` (refuse): `isUNC` true (`\\server\share`).
  - `mapped-network-drive` (refuse): `driveType==='network'` for the path's drive letter.
  - `onedrive` (refuse): `absPath` (case-insensitive) starts with any of `env.OneDrive`, `env.OneDriveConsumer`, `env.OneDriveCommercial`, **or** a path segment matching `/OneDrive([ -][^\\/]+)?/i` (covers "OneDrive - Contoso"). *This repo under `…\Downloads` is only OneDrive if Downloads is redirected into the OneDrive root — the env-prefix check catches exactly that.*
  - `dropbox` (refuse): segment `\Dropbox\` or `env`-declared Dropbox root.
  - `gdrive` (refuse): segment matching `/Google ?Drive|GoogleDrive|DriveFS/i` or a `My Drive` segment.
  - else `local-ok` (safe).
- **macOS (`darwin`)**
  - `icloud` (refuse): under `${homedir}/Library/Mobile Documents` (incl. `com~apple~CloudDocs`).
  - `dropbox` (refuse): `${homedir}/Dropbox` or `~/Library/CloudStorage/Dropbox*`.
  - `gdrive` (refuse): `~/Google Drive`, `~/Library/CloudStorage/GoogleDrive*`.
  - `onedrive` (refuse): `~/Library/CloudStorage/OneDrive*`.
  - else `local-ok`.
- **Linux / WSL**
  - `wsl-cross` (warn): `isWslInterop` true **and** `absPath` starts with `/mnt/<letter>/` (DB on the Windows volume across the 9p/drvfs boundary).
  - `network-unc` (refuse): `mountFsType ∈ {cifs, smb3, nfs, nfs4, fuse.sshfs}`.
  - cloud (refuse): `mountFsType` startsWith `fuse.` for known sync daemons (`fuse.dropbox`, `fuse.rclone`, `fuse.google-drive-ocamlfuse`) → map to `dropbox`/`gdrive`; segment `/Dropbox/`, `/Google ?Drive/`, `/OneDrive/` as a secondary signal.
  - else `local-ok`.
- **Anything unmatched / probe failure** → `unknown` (warn, **fail-open** — never block on uncertainty).

#### Layer B — thin signal gatherer (does the I/O, all probes injectable)
```
gatherSignals(absPath, deps = {}) -> signals
```
`deps` (each defaults to a real impl; tests pass fakes):
- `platform = process.platform`, `env = process.env`, `homedir = os.homedir`
- `probeDriveType(driveLetter)` — Windows. **No native deps:** shell out via `execFileSync('cmd', ['/c','wmic','logicaldrive',…])` is deprecated on Win11; prefer `execFileSync('net', ['use'])` parse for mapped letters + `execFileSync('powershell','-NoProfile','-Command','(Get-PSDrive …).DisplayRoot')` fallback. **Spec gap flagged below (G1).** Probe is wrapped in try/catch → `'unknown'` on failure.
- `probeMounts()` — Linux. Read `/proc/mounts`, find the longest mountpoint that is a prefix of `absPath`, return its fs type.
- `readWslInterop()` — Linux. `true` if `/proc/version` contains `microsoft` (case-insensitive) or `env.WSL_DISTRO_NAME` set.
- `isUNC(absPath)` — pure string test.

**Public entry:** `classifyFilesystem(absPath, deps={}) = classifyFromSignals(gatherSignals(absPath, deps))`. Detector takes **no real-FS dependency in tests** because every probe is injected.

### 1.2 Policy: refuse vs warn (+ escape hatch)

| Class | Tier | Justification |
|-------|------|---------------|
| local-ok | safe | proceed silently |
| onedrive, dropbox, gdrive, icloud | **refuse** | active cloud-sync = highest WAL-corruption risk (sync daemon rewrites `-wal`/`-shm` mid-transaction) |
| network-unc, mapped-network-drive | **refuse** | SQLite locking unreliable over SMB/NFS; documented corruption |
| wsl-cross | warn | works but slow + lock edge cases; not silently corrupting |
| unknown | warn | fail-open: never block a user we can't classify |

**Refuse fires only when the DB path is *inside* the risky root** (the gather already scopes to `absPath`), never on the mere presence of OneDrive elsewhere on the machine.

**Escape hatch:** `FORGE_KERNEL_ALLOW_UNSAFE_FS=1` downgrades every `refuse` → `warn` (proceeds, prints the warning + "override active"). Justification: power users on reliable network homes, CI sandboxes, and incident recovery must not be hard-blocked; an explicit env var is auditable and intentional. (Override does not affect `safe`/`warn`/`unknown`.)

### 1.3 `forge doctor` output contract (JSON-first, mirrors orient/recap)

`forge doctor [--json]`. Handler returns `{ success, output }`.
- `--json` → `output = JSON.stringify(report,null,2)+'\n'`.
- default → one human line per check + a summary line.

Report shape:
```json
{
  "command": "doctor",
  "schemaVersion": 1,
  "ok": true,
  "checks": [
    {
      "id": "filesystem-class",
      "ok": true,
      "databasePath": "<resolved kernel.sqlite path>",
      "class": "local-ok",
      "riskTier": "safe",
      "signal": "no cloud/network/wsl signal matched",
      "remediation": null,
      "overrideActive": false
    }
  ]
}
```
- `ok` (top + per-check) = `riskTier !== 'refuse'` OR override active.
- Human line: `✓ filesystem: local-ok (safe) — <path>` / `✗ filesystem: onedrive (REFUSE) — <remediation>`.
- doctor resolves the path via `buildLocalBrokerConfig({projectRoot}).databasePath` (config build does **no** I/O — F1) so it reports the *exact* path the gate will guard, without creating anything.
- **doctor never throws on a refuse**: it reports `ok:false` and exits non-zero (`result.error` set) so agents/CI can gate on it, but it is a *reporter*, not the enforcer.

### 1.4 Where the default-on gate hooks (exact site) + remediation text

**Hook:** top of `broker.initialize()` in `lib/kernel/broker.js`, **before** the pragma `for` loop (the first `await driver.exec`). Pseudocode:
```js
async initialize() {
  const config = getConfig();                       // no I/O (F1)
  assertFilesystemSafeForKernel(config.databasePath, {
    env: process.env,                               // injectable in tests
  });                                               // throws on refuse unless override
  requireDriverMethod(driver, 'exec');
  for (const statement of config.pragmas) { await driver.exec(statement, config); }
  // … migrations …
}
```
`assertFilesystemSafeForKernel(dbPath, deps)` lives in `lib/kernel/fs-class.js`:
- classify; if `safe`/`warn`/`unknown` → return (warn classes `console.warn` the message).
- if `refuse` and override unset → `throw new Error(REFUSE_MESSAGE)`.
- if `refuse` and `FORGE_KERNEL_ALLOW_UNSAFE_FS` set → `console.warn` + return.

Because it is at `initialize()` top, the throw happens **before** any `driver.exec`, so `kernel.sqlite` is never created on a refuse-class FS (F1/F2). Covers the real wiring (F5) without editing forge-issues.js.

**Remediation message table** (`remediationKey` → text). Example (onedrive, the worked repo case):
```
Forge kernel cannot place its SQLite database on a cloud-synced folder
(OneDrive). SQLite WAL mode corrupts when a sync client rewrites the
database mid-write.

  Detected: OneDrive sync root covers
            <databasePath>
  Class:    onedrive

Fix: move this repository outside the OneDrive folder, e.g.
     C:\dev\<repo>  (a non-synced local path), then re-run.

Override (NOT recommended): set FORGE_KERNEL_ALLOW_UNSAFE_FS=1 to proceed
at your own risk.
```
Network/mapped-drive and icloud/dropbox/gdrive variants follow the same template with class-specific "Fix" lines (move to a local fixed disk; use `\\?\` local path; etc.).

---

## 2. TDD task list (explicit parallel waves)

### Dependency graph
```
        ┌──────────────────────────────┐
Wave 1: │ D19-T1  fs-class detector     │   (foundational, ALONE — everyone depends on it)
        │  lib/kernel/fs-class.js       │
        └───────────────┬──────────────┘
                        │ exports: classifyFilesystem, classifyFromSignals,
                        │ gatherSignals, assertFilesystemSafeForKernel,
                        │ REMEDIATION (table)
            ┌───────────┴───────────┐
Wave 2:     ▼                       ▼          (parallel — disjoint files)
  ┌───────────────────┐   ┌────────────────────────────┐
  │ D19-T2 doctor cmd │   │ D19-T3 broker default-on    │
  │ lib/commands/     │   │ gate                         │
  │   doctor.js       │   │ lib/kernel/broker.js         │
  │ (+ helper reuse   │   │ (initialize() hook only)     │
  │  of T1 + broker   │   └────────────────────────────┘
  │  config builder)  │
  └───────────────────┘
Wave 3 (optional, after both): D19-T4 docs/AGENTS surface note — non-code, sync-commands if needed.
```

### File ownership (no collisions)
| Task | OWNS (writes) | READS only |
|------|---------------|------------|
| D19-T1 | `lib/kernel/fs-class.js`, `test/kernel/fs-class.test.js` | — |
| D19-T2 | `lib/commands/doctor.js`, `test/commands/doctor.test.js` | fs-class.js, broker.js (`buildLocalBrokerConfig`) |
| D19-T3 | edit `lib/kernel/broker.js` `initialize()`, `test/kernel/broker-fs-gate.test.js` (new file) | fs-class.js |
| D19-T4 | docs only (AGENTS.md/doctor reference) | — |

**Critical:** T3 edits `broker.js`; no other D19 task edits it. **No task edits `bin/forge.js`** (F3) — so D19 and the parallel D20 `bin/forge.js` track do not collide at all.

### Conventions every task honors (state in each task)
- RED → GREEN → REFACTOR; one assertion-focused failing test first.
- `bun:test`; **explicit per-test timeout as 3rd arg** (bunfig `[test]` timeout is NOT honored) — e.g. `test('…', () => {…}, 3000)`.
- ESLint `--max-warnings 0`; prefix intentionally-unused params with `_`.
- Run via `forge test` / `forge push` (not raw `bun`/`git`).
- JSON-first output; Windows/Git-Bash shell model.
- **All env/probes injected** — no test reads the real machine FS, drives, or `/proc`.

---

### D19-T1 — Filesystem-class detector (Wave 1, alone)
**RED** — `test/kernel/fs-class.test.js`, all synthetic signals (zero real I/O), table-driven:
- win32: UNC path → `network-unc`/refuse; mapped (`driveType:'network'`) → `mapped-network-drive`/refuse; `env.OneDriveCommercial` prefix → `onedrive`/refuse; `OneDrive - Contoso` segment → onedrive; `\Dropbox\` → dropbox; `Google Drive` segment → gdrive; plain `C:\dev\repo` → `local-ok`/safe; **`C:\Users\x\Downloads\forge` with NO OneDrive env → `local-ok`** (guards against false-positive on Downloads); same path **with** `env.OneDrive=C:\Users\x\OneDrive` and DB under it → onedrive.
- darwin: `~/Library/Mobile Documents/...` → icloud; `~/Dropbox` → dropbox; `~/Google Drive` → gdrive; else local-ok.
- linux/WSL: `isWslInterop && /mnt/c/...` → `wsl-cross`/warn; `mountFsType:'cifs'` → network-unc/refuse; `fuse.rclone` → gdrive/refuse; native ext4 → local-ok.
- unknown/probe-throw → `unknown`/warn (fail-open).
- `assertFilesystemSafeForKernel`: refuse class **throws**; same with `FORGE_KERNEL_ALLOW_UNSAFE_FS=1` (injected env) **does not throw** (warns); warn class never throws.
- Each `Classification` carries `remediationKey` resolving to non-empty `REMEDIATION[key]`.

**GREEN** — implement `classifyFromSignals` (pure), `gatherSignals` (injected probes, try/catch→unknown), `classifyFilesystem`, `assertFilesystemSafeForKernel`, `REMEDIATION` table. No native modules.
**REFACTOR** — extract per-platform signal arrays into a precedence-ordered table; dedupe path-prefix helper (case-insensitive on win32). Export all four fns + table.

### D19-T2 — `forge doctor` command (Wave 2, parallel to T3)
**RED** — `test/commands/doctor.test.js`:
- handler returns `{success:true, output}` with valid JSON when `--json`; report has `command/schemaVersion/ok/checks[0]`.
- inject a stub classifier (or temp projectRoot + injected env) so `class:'onedrive'` → `ok:false`, human line contains `REFUSE` + remediation; `local-ok` → `ok:true`, `✓`.
- module shape: exports `{name:'doctor', description, usage, handler}` (F4) — assert it passes `_registry.validateCommand`.
- `databasePath` in report equals `buildLocalBrokerConfig({projectRoot}).databasePath`; calling doctor creates **no** file (assert path does not exist after).

**GREEN** — implement `doctor.js`: resolve path via `buildLocalBrokerConfig`, call `classifyFilesystem`, build report, format text vs `--json` like recap.js. **No `bin/forge.js` edit** (auto-discovery, F3).
**REFACTOR** — extract `buildDoctorReport(projectRoot, deps)` (pure-ish, injectable classifier) from the handler for testability; keep handler thin.

### D19-T3 — Broker default-on gate (Wave 2, parallel to T2)
**RED** — `test/kernel/broker-fs-gate.test.js` (mirrors broker.test.js fake-driver style, F6):
- broker built with `databasePath` on a refuse-class path (injected classifier/env) → `await broker.initialize()` **rejects**, and the fake driver records **zero** `exec` calls (proves no file/pragma before throw).
- same path with `FORGE_KERNEL_ALLOW_UNSAFE_FS=1` (injected) → `initialize()` resolves and pragmas run.
- `local-ok` path → `initialize()` resolves normally (regression guard).
- per-test timeout 3rd arg (3000).

**GREEN** — add `assertFilesystemSafeForKernel(config.databasePath, {env})` call as the **first statement** of `initialize()` (before `requireDriverMethod`/pragma loop). Allow `options.env`/`options.classifyFilesystem` injection through the broker for deterministic tests.
**REFACTOR** — ensure existing broker tests still green; confirm gate is a no-op for `:memory:`/`file:` paths (those classify `local-ok`).

### D19-T4 — Surface note (Wave 3, optional, non-code)
Document `forge doctor` + `FORGE_KERNEL_ALLOW_UNSAFE_FS` in AGENTS.md/doctor reference; run `node scripts/sync-commands.js` if any `.claude/commands` file is added. No source edits.

---

## 3. Ambiguity policy — flagged spec gaps (7-dim rubric)

- **G1 — Windows mapped-drive probe mechanism (confidence ~72%, <80 → FLAG).** Detecting "is drive Z: a network mapping" dependency-free on Win11 is the one fragile probe. `wmic` is deprecated/absent on newer Win11; `net use` parsing covers mapped letters but not all SMB cases; `Get-PSDrive .DisplayRoot` needs PowerShell. **Recommendation pending user:** (a) ship `net use` parse + PowerShell fallback, probe wrapped try/catch→`unknown` (warn) so a probe miss fails open, OR (b) treat all non-`C:` fixed-looking letters as `unknown`/warn and rely on UNC + cloud-env detection (which catch the highest-risk cases) for v1. UNC and cloud-sync detection — the dominant corruption sources — are unaffected either way. **Please confirm (a) or (b).**
- **G2 — `unknown` tier = warn, not refuse (confidence ~85%, proceed + documented).** Fail-open chosen so unclassifiable-but-fine setups aren't hard-blocked; refuse is reserved for positively-identified cloud/network. Assumption documented here.
- **G3 — doctor scope = single `filesystem-class` check for D19 (confidence ~90%, proceed).** `checks[]` array is future-proof but D19 ships exactly one check; broader health stays in `runtime-health.js` per scope discipline. Documented.
