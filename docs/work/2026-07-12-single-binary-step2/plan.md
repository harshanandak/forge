# Single-binary Step 2 — embed runtime assets + extraction

Issue: 9460dda1-2e69-4390-8f57-c62462118407

## Problem

`forge setup` (and a few runtime commands) copy runtime assets (`skills/`, `rules/`,
essential docs, `AGENTS.md`, `.claude/scripts/*`, `.forge/hooks/*`, workflow `scripts/*`)
FROM the on-disk package directory into the target project. A `bun build --compile`
single binary has NO package directory on disk, so every `path.join(packageDir, <asset>)`
read breaks. Step 2 makes those assets available in the compiled channel while keeping
the npm/npx channel byte-identical.

## Design: extract-then-delegate (single helper, both channels)

`lib/package-root.js` exposes `getPackageRoot(diskFallback)`:

- **npm/npx/dev**: returns the real on-disk package root (verified to carry assets).
- **compiled binary**: lazily extracts the embedded assets to a per-USER cache dir
  keyed by version + asset fingerprint (`%LOCALAPPDATA%\forge\assets-<version>-<fp>` on
  Windows, `$XDG_CACHE_HOME|~/.cache/forge/assets-<version>-<fp>` on POSIX, `0o700`), then
  returns it. Every existing copy path then reads real files from a real dir — no
  per-consumer rewrite.

Two distinct uses of `packageDir` were separated: **module `require()`s** (bundler
concern, left alone) vs **asset reads** (routed through the helper).

### Embedding mechanism

Bun import attributes (`import x from "./f" with { type: "file" }`) via a GENERATED
manifest `lib/embedded-assets.generated.mjs` (gitignored), produced by
`scripts/gen-embedded-assets.mjs` walking `ASSET_ROOTS`. Chosen over CLI-glob
(`bun build ... skills/**`) because `Bun.embeddedFiles` exposes only a hashed,
directory-less basename — every `SKILL.md` would collide. The generated map keys by the
true relative POSIX path; the value is that file's own embedded path, so extraction maps
manifest-path → blob and NEVER derives paths from embedded names (guidance #2).

### Extraction detail (proven in a real compiled binary)

- **Per-user cache dir, not shared tmp** (reliability MAJOR #2): assets extract to
  `%LOCALAPPDATA%\forge\assets-<version>` (Windows) / `$XDG_CACHE_HOME|~/.cache/forge/…`
  (POSIX, `0o700`), NOT `os.tmpdir()`. A world-writable tmp would let a local attacker
  pre-plant the path with a valid sentinel + malicious `.forge/hooks/*` that setup would
  install.
- **Atomic + concurrency-safe** (reliability MAJOR #1): extraction writes all files + the
  sentinel into a private `mkdtempSync` sibling, then `renameSync`s it into the final
  version-stamped path in ONE step. A half-written temp never acquires the final name, so
  a crash mid-extract or a racing second process can never observe/bless a partial dir,
  and no process `rmSync`es a dir another is reading. If the final path already exists
  (another process won), we discard our temp and adopt theirs.
- **Real completeness check** (hardening): after extraction, `assertAllPresent` stats each
  expected relpath and asserts non-empty (replaces the near-tautological count check),
  throwing the list of any missing.
- **Traversal guard** (hardening): `extractEmbeddedAssets` rejects any manifest key that is
  absolute or contains a `..` segment before writing.
- `fs.writeFileSync(out, fs.readFileSync(embeddedPath))` — NOT `copyFileSync`: Bun's
  embedded `/$bunfs/…` (`B:/~BUN/root/…`) source paths support `readFileSync` but the
  copyfile syscall ENOENTs on them. Binary buffer copy → no line-ending translation.
- Relative POSIX paths are split and re-joined with the platform separator only at write
  time (guidance #2).
- Executable bit: files-only embedding drops mode, so the manifest records
  `EXECUTABLE_ASSETS` (`.sh` + `.forge/hooks/*`); extraction `chmod 0o700` (owner-only
  rwx — this is a per-user cache dir; no-op on Windows) (guidance #7).
- Symlinks are never embedded — the generator skips them; content is materialized
  (guidance #7).

## Mode detection (guidance #3 / reconciliation B)

- **Primary**: compile-time constant `FORGE_COMPILED`, injected by `build:binary`
  (`--define FORGE_COMPILED=true`), read via a `typeof`-guarded `/* global */` reference.
- **Fallback**: `Bun.embeddedFiles.length > 0` (injectable for unit tests).
- **Safe default**: `getPackageRoot` tries the on-disk package first (real assets win),
  then the embedded channel; if BOTH fail it THROWS listing both attempted sources —
  never returns an asset-less dir that lets setup "succeed" with nothing.
- **Post-extract stat-check**: after extraction, `assertAllPresent` stats every expected
  relpath and asserts it exists + is non-empty (throws listing any missing) — a real
  content check, not a count of the same manifest it iterates.
- **Completion sentinel + content re-validation**: `.forge-assets-complete` (holds the
  version) is written only after a fully-successful extraction; the fast-path reuse
  re-runs the stat-check before trusting the sentinel, so a truncated/partly-deleted
  cache re-extracts rather than being adopted. A crash mid-extraction or a concurrent
  process can never bless a partial dir (atomic rename, below) (guidance #8 / open-Q3).
- **Cache identity includes an asset fingerprint**: the dir name embeds a content hash
  (`ASSET_FINGERPRINT`) emitted by the generator, so a same-version rebuild with a
  changed asset set lands in a different dir and never reuses a stale extraction.

## Drift / completeness guard (guidance #1 / reconciliation A)

The generated `.mjs` is gitignored, so instead of diffing a committed artifact,
`test/embedded-assets-drift.test.js` (fast, no compile) walks `ASSET_ROOTS` on disk via
an INDEPENDENT recursive walk and asserts the embed set == the on-disk asset set BOTH
ways, plus that every critical setup consumer's source (AGENTS.md, each `skills/*/SKILL.md`,
each `rules/*.md`, hook scripts, `load-env.sh`, `scripts/forge-team/index.sh`) is embedded
and that embedded text bytes are LF-only. A new skill/rule/script file that would ship
un-embedded fails this test.

## Line endings (guidance #6 / reconciliation C)

`.gitattributes` already had global `* text=auto eol=lf`; added explicit `eol=lf` for
`skills/** rules/** docs/** scripts/** .forge/hooks/** .claude/scripts/** AGENTS.md`
(before the binary rules so images still win). The drift test asserts no CR byte in
embedded text assets, so Windows-dev vs Linux-CI embed bytes cannot flap across step-3's
5 cross-compiled targets.

## Consumers rerouted through the helper

Asset roots computed at these sites now go through `getPackageRoot`:
- `lib/commands/setup.js` — 11 asset sites (skills, docs, AGENTS.md×5, load-env.sh,
  .forge/hooks, codex skills, workflow runtime assets, scaffoldBeadsSync source).
- `lib/agents-config.js` — `renderRulesForHarness` sourceRoot (rules/).
- `lib/config-writer.js` — skill search dir.
- `lib/commands/team.js` — `forge team` → `scripts/forge-team/index.sh` (runtime).
- `lib/reset.js` — `resetHard` default sourceRoot (runtime skill re-copy).
- `bin/forge.js` — `forge docs` → `getTopicContent` (runtime).

Module-`require` sites keep `packageDir` (bundler concern). The `bin/forge.js` inline
setup body is DEAD (defers to `lib/commands/setup.js`) — not touched.

## Scope of the helper (guidance #9)

`getPackageRoot()` + `extractEmbeddedAssets()` + `listAssets()` — the minimal
list/read/copy surface sufficient for steps 3 and 4. No generic VFS.

## Forward-compat locked in (guidance #8)

- Manifest generation runs INSIDE `build:binary` (not manual) → all 5 step-3 targets
  embed identical content.
- Embedded assets carry no absolute paths.
- Extracted assets are version-stamped (dir name + sentinel) so step-4's installer can
  detect stale extractions.
- Overwrite/skip semantics match the npm copy path EXACTLY by construction: the compiled
  channel extracts to a temp dir and then runs the SAME copy logic (copyEssentialDocs
  skips existing; populateAgentSkills clean:false overwrites Forge skills).

## Parity (guidance #5)

`scripts/parity-check.mjs` (`bun run parity:binary`) builds the binary and runs
`forge setup` from BOTH channels into throwaway git projects, comparing relative-path set
+ per-file SHA-256. This is the "one real-compile leg". It cannot go GREEN until the
Step-1 gap below is fixed (the full binary crashes at startup), so wiring it into CI is
left to step-3; the script is ready.

## Validation performed

- Unit: `test/package-root.test.js` (mode detection both signals, safe-default throw,
  extraction+exec-bit) — 10 tests.
- Drift/completeness + LF: `test/embedded-assets-drift.test.js` — 4 tests.
- Regression (npm channel unchanged): 155 tests across setup-docs-copy, setup-runtime-assets,
  config-writer, incremental-setup, setup-shared-helper, codex-skills, skills-structure,
  reset, reset-hard, docs-command.
- **Real compiled binary**: an isolated smoke entry proved embed+extract round-trips —
  `isCompiledBinary: true`, 142 assets, `skills/plan/SKILL.md` extracted (24238 bytes,
  nested path intact), executable script + AGENTS.md + sentinel present.

## Consciously deferred (filed, not lost)

- **Step-1 dynamic-require gap** (issue 53770b23): `require(path.join(packageDir,'lib',…))`
  is not bundled by `bun compile`, so `context-merge → fastest-levenshtein` is missing at
  runtime — the full binary crashes at startup. This blocks the end-to-end setup smoke +
  parity. It is Step-1 (JS bundling), not Step-2 (assets); embedding is proven independently.
- **copyEssentialDocs no-op** (issue filed): it reads `docs/<doc>` but TOOLCHAIN.md /
  VALIDATION.md live under `docs/reference/` + `docs/forge/`, so it currently copies
  nothing in EITHER channel. Parity preserved; fixing the source path is out of scope.
- **Full `docs/` tree embedding** for `forge docs <arbitrary-topic>` and `lib/agents/*.md`
  plugin discovery — separate embed-set/binary-size decisions, not needed for setup;
  deferred to step 3.

## Out of scope

Step 3 (CI cross-compile matrix) and Step 4 (install script). No changes to
module-require resolution.

## 9-point guidance mapping (for the PR reliability review)

1. Generated single-source manifest + drift guard → drift test walks disk, embeds
   in-memory, asserts both-ways completeness. ✅
2. Dir structure not derived from embedded names → manifest keys by true POSIX relpath;
   platform separators only at write time. ✅
3. Injected `--define FORGE_COMPILED=true` primary, `Bun.embeddedFiles` fallback,
   disk-first-then-embedded safe default, loud throw if both fail, post-extract count
   assertion. ✅
4. All packageDir consumers audited → setup + agents-config + config-writer + team +
   reset + docs routed; full-docs/plugin-agents deferred with reason. ✅ (partial-by-design)
5. Byte-for-byte parity script (relpath set + SHA-256) wired; CI leg deferred to step-3
   (blocked by the Step-1 gap). ✅ (script) / deferred (CI leg)
6. `.gitattributes` LF on embedded trees + drift test asserts LF. ✅
7. Exec-bit recorded per asset + chmod on extract; symlinks never embedded; no scaffold
   empty dirs required. ✅
8. Manifest gen inside build script; version-stamp + sentinel for stale detection;
   overwrite/skip identical to npm by construction. ✅
9. Minimal list/read/copy surface, no generic VFS. ✅
