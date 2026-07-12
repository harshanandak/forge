'use strict';

/* global FORGE_COMPILED */

/**
 * @module package-root
 *
 * Dual-channel resolution of the Forge "package root" — the directory that ships
 * the runtime assets `forge setup` (and a few runtime commands) copy into a
 * target project (`skills/`, `rules/`, essential docs, `AGENTS.md`, hook scripts,
 * workflow runtime scripts).
 *
 * Two distribution channels must both work:
 *
 *   1. npm / npx install → the package is a real directory on disk. The root is
 *      the Forge repo/package root (`lib/` → `..`). Historical path; unchanged.
 *
 *   2. `bun build --compile` single-file binary → there is NO package directory
 *      on disk. The runtime assets are embedded at compile time (Bun import
 *      attributes, see `scripts/gen-embedded-assets.mjs`) and this module
 *      materializes them into a temp directory on first use, then hands that
 *      directory to the existing (unchanged) copy logic. This "extract then
 *      delegate" keeps every downstream asset consumer working without a rewrite.
 *
 * Every consumer that READS a packaged asset off the package root goes through
 * `getPackageRoot(diskFallback)`:
 *   - npm/dev: returns `diskFallback` (verified to actually contain assets).
 *   - compiled: returns the memoized, sentinel-guarded extraction directory.
 *
 * Module `require()`s that resolve code (`require(path.join(packageDir,'lib',…))`)
 * are NOT asset reads and are intentionally left alone — those are handled by the
 * bundler when compiling, not by this helper.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** On-disk package root for the npm/dev channel: `lib/` → repo root. */
const DISK_PACKAGE_ROOT = path.resolve(__dirname, '..');

/** Filename written into the extraction dir after a fully-successful extraction. */
const SENTINEL_FILE = '.forge-assets-complete';

/**
 * Asset roots that Forge reads from the package root. Directory entries are
 * embedded recursively; file entries individually. The generator
 * (`scripts/gen-embedded-assets.mjs`) walks exactly this list, so it is the
 * single source of truth for "what ships inside the compiled binary".
 *
 * Kept in sync with the setup/runtime consumers (asserted by
 * test/embedded-assets-drift.test.js):
 *   - skills/**            → populateAgentSkills, listCanonicalSkills, codex skills, reset
 *   - rules/**             → renderRulesForHarness (agents-config)
 *   - docs/{TOOLCHAIN,VALIDATION}.md → copyEssentialDocs
 *   - AGENTS.md            → workflow contract copied into the project
 *   - .claude/scripts/**   → load-env.sh, review-resolve.sh
 *   - .forge/hooks/**      → check-tdd.js, forge-native-hook.js
 *   - scripts/**           → WORKFLOW_RUNTIME_ASSETS (team + workflow scripts), `forge team`
 */
const ASSET_ROOTS = Object.freeze([
  'skills',
  'rules',
  'docs/TOOLCHAIN.md',
  'docs/VALIDATION.md',
  'AGENTS.md',
  '.claude/scripts',
  '.forge/hooks',
  'scripts',
]);

/**
 * Compile-time signal injected by `build:binary` via `--define FORGE_COMPILED=true`.
 * The `global` directive above tells ESLint the identifier exists; the `typeof`
 * guard prevents a ReferenceError under node where it is never defined.
 */
function isCompiledByDefine() {
  try {
    return typeof FORGE_COMPILED !== 'undefined' && FORGE_COMPILED === true;
  } catch {
    return false;
  }
}

/**
 * True when running inside a `bun build --compile` single-file executable that
 * carries embedded assets. Primary signal is the injected `FORGE_COMPILED`
 * constant; `Bun.embeddedFiles` is a runtime FALLBACK. Under `node` (npm) and a
 * plain `bun test` (not compiled) both are false → the on-disk path is used.
 *
 * @param {*} [bun] - Bun runtime object; injectable for tests (the real
 *   `globalThis.Bun` is a read-only property and cannot be mocked by assignment).
 */
function isCompiledBinary(bun = globalThis.Bun) {
  if (isCompiledByDefine()) return true;
  try {
    if (!bun || bun.embeddedFiles == null) return false;
    return Array.from(bun.embeddedFiles).length > 0;
  } catch {
    return false;
  }
}

/** A directory qualifies as a real on-disk package root if it carries the core assets. */
function hasDiskAssets(dir) {
  return (
    !!dir &&
    fs.existsSync(path.join(dir, 'skills')) &&
    fs.existsSync(path.join(dir, 'AGENTS.md'))
  );
}

/** Resolve a stable version tag for the extraction directory + sentinel. */
function resolveVersion() {
  try {
    // Literal path so the bundler embeds package.json into the binary too.
    return require('../package.json').version || 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * Load the compile-time embedded-asset manifest. Only ever reached inside a
 * compiled binary, where the generated module is bundled at build time. The
 * literal specifier lets Bun's compiler discover and embed it; the guard in
 * `getPackageRoot` ensures node/npm never executes this line (the generated
 * file is gitignored and absent there).
 *
 * @returns {{ EMBEDDED_ASSETS: Record<string,string>, EXECUTABLE_ASSETS: string[] }}
 */
function loadEmbeddedManifest() {
  return require('./embedded-assets.generated.mjs');
}

/** Split a POSIX relative path into segments for platform-correct joining. */
function relSegments(relPosix) {
  return relPosix.split('/').filter(Boolean);
}

/**
 * Extract every embedded asset into `destDir`, preserving relative paths and
 * restoring the executable bit on scripts/hooks (files-only embedding drops
 * mode). Node `fs` reads the `/$bunfs/…` embedded paths directly. Returns the
 * number of files written so the caller can assert completeness.
 *
 * @param {string} destDir
 * @param {Record<string,string>} [assets] - relPath → source path map. Defaults
 *   to the compile-time embedded manifest; injectable for unit tests.
 * @param {string[]} [executable] - relPaths needing chmod +x. Defaults to manifest.
 * @returns {number} count of files written
 */
function extractEmbeddedAssets(destDir, assets, executable) {
  if (!assets) {
    const manifest = loadEmbeddedManifest();
    assets = manifest.EMBEDDED_ASSETS;
    executable = manifest.EXECUTABLE_ASSETS || [];
  }
  const execSet = new Set(executable || []);
  let count = 0;
  for (const [relPath, embeddedPath] of Object.entries(assets)) {
    // Defense-in-depth: the manifest is compile-time-trusted, but never let a
    // key escape destDir via traversal or an absolute path.
    const segs = relSegments(relPath);
    if (path.isAbsolute(relPath) || segs.includes('..') || segs.length === 0) {
      throw new Error(`Refusing to extract unsafe embedded asset path: ${JSON.stringify(relPath)}`);
    }
    const outPath = path.join(destDir, ...segs);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // read+write (not copyFileSync): Bun's embedded `/$bunfs/…` source paths
    // support readFileSync but NOT the copyfile syscall. Binary buffer copy — no
    // encoding/line-ending translation. Works identically for real disk files.
    fs.writeFileSync(outPath, fs.readFileSync(embeddedPath));
    if (execSet.has(relPath)) {
      try {
        fs.chmodSync(outPath, 0o755); // no-op semantics on Windows
      } catch {
        // Non-fatal: mode restore best-effort; the copy already succeeded.
      }
    }
    count += 1;
  }
  return count;
}

/**
 * Per-USER cache root for extracted assets. NOT `os.tmpdir()` — a world-writable
 * shared tmp lets a local attacker pre-plant `forge-assets-<version>/` with a
 * valid sentinel + malicious hook scripts that `forge setup` would then install.
 * Windows: `%LOCALAPPDATA%`; POSIX: `$XDG_CACHE_HOME` or `~/.cache`. The `forge`
 * dir is created `0o700` on POSIX so only the owner can populate it.
 */
function userCacheRoot() {
  let base;
  if (process.platform === 'win32') {
    base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  } else {
    base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  }
  const root = path.join(base, 'forge');
  fs.mkdirSync(root, { recursive: true });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(root, 0o700);
    } catch {
      // Best-effort ownership hardening; not fatal.
    }
  }
  return root;
}

/** True iff `dir` holds a completion sentinel matching this version. */
function isCompleteExtraction(dir, version) {
  try {
    const sentinel = path.join(dir, SENTINEL_FILE);
    return fs.existsSync(sentinel) && fs.readFileSync(sentinel, 'utf8').trim() === version;
  } catch {
    return false;
  }
}

/** Assert every expected relpath exists on disk under `dir` and is non-empty. */
function assertAllPresent(dir, assets) {
  const missing = [];
  for (const rel of Object.keys(assets)) {
    const p = path.join(dir, ...relSegments(rel));
    let ok = false;
    try {
      ok = fs.statSync(p).size > 0;
    } catch {
      // Missing or unreadable → counts as absent below.
    }
    if (!ok) missing.push(rel);
  }
  if (missing.length > 0) {
    const sample = missing.slice(0, 10).join(', ');
    throw new Error(
      `Forge embedded-asset extraction incomplete: ${missing.length} file(s) missing or empty in ${dir} ` +
        `(e.g. ${sample}${missing.length > 10 ? ', …' : ''}). Rebuild with \`bun run build:binary\`.`
    );
  }
}

let _extractedRoot = null;

/**
 * Materialize embedded assets, atomically and concurrency-safely.
 *
 * Extraction writes into a PRIVATE `mkdtempSync` sibling dir (all files + the
 * completion sentinel), then `renameSync`s it into the final version-stamped
 * path in ONE atomic step. A half-written temp NEVER acquires the final name, so
 * a crash mid-extraction or a second process racing us can never observe (or
 * bless) a partially-populated dir — and no process ever `rmSync`es a dir another
 * process is reading. If the final path already exists (another process won),
 * we discard our temp and adopt theirs.
 */
function ensureExtracted() {
  if (_extractedRoot) return _extractedRoot;
  const version = resolveVersion();
  const cacheRoot = userCacheRoot();
  const finalDir = path.join(cacheRoot, `assets-${version}`);

  // Fast path: a completed extraction for this exact version already exists.
  if (isCompleteExtraction(finalDir, version)) {
    _extractedRoot = finalDir;
    return finalDir;
  }

  const manifest = loadEmbeddedManifest();
  const tmpDir = fs.mkdtempSync(path.join(cacheRoot, `.assets-${version}-`));
  try {
    extractEmbeddedAssets(tmpDir, manifest.EMBEDDED_ASSETS, manifest.EXECUTABLE_ASSETS || []);
    assertAllPresent(tmpDir, manifest.EMBEDDED_ASSETS);
    fs.writeFileSync(path.join(tmpDir, SENTINEL_FILE), version, 'utf8');
    try {
      fs.renameSync(tmpDir, finalDir);
    } catch (err) {
      // Another process already materialized finalDir (rename onto a non-empty
      // dir fails) — discard ours and adopt theirs if it is complete.
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (isCompleteExtraction(finalDir, version)) {
        _extractedRoot = finalDir;
        return finalDir;
      }
      throw err;
    }
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of the private temp dir.
    }
    throw err;
  }
  _extractedRoot = finalDir;
  return finalDir;
}

/**
 * The directory to read packaged assets from, for BOTH channels.
 *
 * Resolution order (safe-default): a real on-disk package (npm/npx/dev) wins;
 * otherwise a compiled binary extracts its embedded assets; otherwise BOTH
 * channels failed and we throw loudly listing both attempts — never silently
 * return an empty dir that lets setup "succeed" with nothing.
 *
 * @param {string} [diskFallback] - The caller's own on-disk package root.
 * @returns {string}
 */
function getPackageRoot(diskFallback = DISK_PACKAGE_ROOT) {
  // 1. Disk channel — a real package dir that actually carries assets.
  if (hasDiskAssets(diskFallback)) {
    return diskFallback;
  }
  // 2. Embedded channel — compiled binary (or disk assets simply absent).
  if (isCompiledBinary()) {
    return ensureExtracted();
  }
  // 3. Both channels failed — fail loud, never return an asset-less dir.
  throw new Error(
    'Cannot resolve Forge runtime assets. Tried:\n' +
      `  1. on-disk package root: ${diskFallback} (missing skills/ or AGENTS.md)\n` +
      '  2. embedded assets: not a compiled binary (no FORGE_COMPILED / Bun.embeddedFiles)\n' +
      'A published npm install should always satisfy (1); a single-file binary should satisfy (2).'
  );
}

/**
 * List the relative POSIX paths of all embedded assets (compiled binary only).
 * Minimal read surface for steps 3/4; returns [] outside a compiled binary.
 */
function listAssets() {
  if (!isCompiledBinary()) return [];
  try {
    return Object.keys(loadEmbeddedManifest().EMBEDDED_ASSETS).sort();
  } catch {
    return [];
  }
}

/** Test-only: reset the memoized extraction directory. */
function _resetForTests() {
  _extractedRoot = null;
}

module.exports = {
  getPackageRoot,
  isCompiledBinary,
  extractEmbeddedAssets,
  listAssets,
  hasDiskAssets,
  ASSET_ROOTS,
  DISK_PACKAGE_ROOT,
  SENTINEL_FILE,
  _resetForTests,
};
