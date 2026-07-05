'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  buildMigrationDryRunReport,
  renderMigrationDryRunReport,
} = require('../migrate-dry-run');
const {
  loadBeadsSnapshotFromDirectory,
  importBeadsSnapshot,
} = require('../adapters/beads-kernel-compat');
const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');

function hasArg(args, name) {
  return Array.isArray(args) && args.includes(name);
}

/**
 * Parse `forge migrate` options from positional args (with a parsed flags object
 * as a fallback). Supported: --from <source>, --source <dir>, --dry-run, --json.
 * Unknown tokens are ignored so the legacy v2→v3 PoC flags pass through untouched.
 */
function parseMigrateOptions(args = [], flags = {}) {
  const options = {
    from: flags.from,
    source: flags.source,
    dryRun: Boolean(flags.dryRun || flags['dry-run']),
    json: Boolean(flags.json),
    errors: [],
  };

  const takeValue = (arg, prefix, current, index) => {
    if (arg.startsWith(`${prefix}=`)) {
      const value = arg.slice(prefix.length + 1);
      if (!value) options.errors.push(`${prefix} requires a value`);
      return { value: value || current, next: index };
    }
    const candidate = args[index + 1];
    if (candidate && !candidate.startsWith('--')) {
      return { value: candidate, next: index + 1 };
    }
    options.errors.push(`${prefix} requires a value`);
    return { value: current, next: index };
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--from' || arg.startsWith('--from=')) {
      const parsed = takeValue(arg, '--from', options.from, i);
      options.from = parsed.value;
      i = parsed.next;
    } else if (arg === '--source' || arg.startsWith('--source=')) {
      const parsed = takeValue(arg, '--source', options.source, i);
      options.source = parsed.value;
      i = parsed.next;
    }
    i += 1;
  }

  return options;
}

function directoryHasJsonl(dir, fsImpl) {
  try {
    return fsImpl.readdirSync(dir).some(entry => entry.endsWith('.jsonl'));
  } catch (_err) {
    /* intentional: unreadable directory has no usable jsonl */ // NOSONAR S2486
    return false;
  }
}

/**
 * Export a Dolt-only Beads store to JSONL in a temp dir via `bd export --all`,
 * then return that dir for the loader. Defensive: a missing `bd` on PATH yields a
 * clear, actionable error instead of a stack trace.
 *
 * NOTE (flagged ambiguity): the exact on-disk shape `bd export --all` emits is not
 * pinned in this repo. We capture stdout into `<temp>/issues.jsonl`, which the
 * loader reads. Operators with a different layout should prefer `--source <dir>`.
 */
function exportDoltStoreToJsonl(beadsDir, projectRoot, deps) {
  const exec = deps.execFileSync || execFileSync;
  const fsImpl = deps.fs || fs;
  const tempDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'forge-migrate-bd-'));
  try {
    const stdout = exec('bd', ['export', '--all'], {
      cwd: projectRoot || process.cwd(),
      encoding: 'utf8',
    });
    fsImpl.writeFileSync(path.join(tempDir, 'issues.jsonl'), stdout || '');
    return { dir: tempDir, kind: 'dolt-export', temp: tempDir };
  } catch (err) {
    fsImpl.rmSync(tempDir, { recursive: true, force: true });
    const message = err && err.message ? err.message : String(err);
    if (/ENOENT|not found|not recognized|no such file/i.test(message)) {
      return {
        error:
          "Beads CLI 'bd' is not on PATH — cannot export the Dolt store at " +
          `${beadsDir}. Install bd, or pass --source <dir> with exported *.jsonl files.`,
      };
    }
    return { error: `bd export --all failed: ${message}` };
  }
}

/**
 * Resolve the directory holding Beads JSONL the loader will read.
 *   1. --source wins (used as given).
 *   2. else auto-detect a `.beads/` dir containing *.jsonl.
 *   3. else a Dolt-only `.beads/` (no jsonl) → `bd export --all` into a temp dir.
 *   4. else nothing found.
 */
function resolveBeadsSource(options, projectRoot, deps) {
  const fsImpl = deps.fs || fs;
  const root = projectRoot || process.cwd();

  if (options.source) {
    const dir = path.resolve(root, options.source);
    if (!fsImpl.existsSync(dir)) {
      return { error: `No beads data found at --source ${dir} (directory does not exist)` };
    }
    return { dir, kind: 'source' };
  }

  const beadsDir = path.join(root, '.beads');
  if (fsImpl.existsSync(beadsDir)) {
    if (directoryHasJsonl(beadsDir, fsImpl)) {
      return { dir: beadsDir, kind: 'jsonl-autodetect' };
    }
    return exportDoltStoreToJsonl(beadsDir, root, deps);
  }

  return {
    error:
      'No beads data found. Looked for a .beads/ directory with *.jsonl under ' +
      `${root}. Pass --source <dir> to point at an exported Beads store.`,
  };
}

function cleanupResolved(resolved, deps) {
  if (resolved && resolved.temp) {
    const fsImpl = deps.fs || fs;
    fsImpl.rmSync(resolved.temp, { recursive: true, force: true });
  }
}

function summarizeGaps(gaps) {
  const items = Array.isArray(gaps) ? gaps : [];
  return {
    count: items.length,
    items: items.map(gap => ({ field: gap.field, reason: gap.reason })),
  };
}

function renderHuman(payload) {
  if (payload.error) {
    return `forge migrate failed: ${payload.error}`;
  }

  const gaps = payload.gaps || { count: 0, items: [] };
  const gapBrief = gaps.count > 0
    ? ` (${gaps.items.map(item => item.field).join(', ')})`
    : '';

  if (payload.dryRun) {
    return [
      `Dry run — would import beads → kernel from ${payload.source}:`,
      `  issues: ${payload.planned.issues}, comments: ${payload.planned.comments}, ` +
        `dependencies: ${payload.planned.dependencies}, events: ${payload.planned.events ?? 0}`,
      `  gaps: ${gaps.count}${gapBrief}`,
      '  (nothing written to the kernel)',
    ].join('\n');
  }

  const imported = payload.imported;
  const importedEvents = imported.events || { inserted: 0, skipped: 0 };
  return [
    `Migrated beads → kernel from ${payload.source}:`,
    `  issues: ${imported.issues.inserted} imported, ${imported.issues.skipped} skipped`,
    `  comments: ${imported.comments.inserted} imported, ${imported.comments.skipped || 0} skipped`,
    `  dependencies: ${imported.dependencies.inserted} imported, ` +
      `${imported.dependencies.skipped} skipped`,
    `  events: ${importedEvents.inserted} imported, ${importedEvents.skipped || 0} skipped`,
    `  gaps: ${gaps.count}${gapBrief}`,
  ].join('\n');
}

function finalize(options, payload, exitCode) {
  const output = options.json ? JSON.stringify(payload, null, 2) : renderHuman(payload);
  const result = { ...payload, output, json: Boolean(options.json) };
  if (payload.success === false && Number.isInteger(exitCode)) {
    result.exitCode = exitCode;
  }
  return result;
}

/**
 * Beads → Forge Kernel transport. Reuses the faithful-import spine end-to-end:
 * loadBeadsSnapshotFromDirectory → importBeadsSnapshot → broker.importIssues.
 */
async function runBeadsMigration(options, projectRoot, opts) {
  const now = opts._now || new Date().toISOString();
  const deps = { execFileSync: opts._execFileSync, fs: opts._fs };

  const resolved = resolveBeadsSource(options, projectRoot, deps);
  if (resolved.error) {
    return finalize(options, { success: false, from: 'beads', error: resolved.error }, 1);
  }

  let snapshot;
  try {
    snapshot = loadBeadsSnapshotFromDirectory(resolved.dir);
  } catch (err) {
    cleanupResolved(resolved, deps);
    return finalize(
      options,
      { success: false, from: 'beads', source: resolved.dir, error: `Failed to read beads data: ${err.message}` },
      1,
    );
  }

  if (snapshot.issues.length === 0 && snapshot.comments.length === 0 && snapshot.dependencies.length === 0) {
    cleanupResolved(resolved, deps);
    return finalize(
      options,
      { success: false, from: 'beads', source: resolved.dir, error: `No beads data found in ${resolved.dir}` },
      1,
    );
  }

  let kernel;
  let report;
  try {
    ({ kernel, report } = importBeadsSnapshot(snapshot, { importedAt: now }));
  } catch (err) {
    cleanupResolved(resolved, deps);
    return finalize(
      options,
      { success: false, from: 'beads', source: resolved.dir, error: `Failed to map beads data: ${err.message}` },
      1,
    );
  }
  const gaps = summarizeGaps(report?.gaps);
  const planned = {
    issues: kernel.issues.length,
    comments: kernel.comments.length,
    dependencies: kernel.dependencies.length,
    events: Array.isArray(kernel.activityEvents) ? kernel.activityEvents.length : 0,
  };

  if (options.dryRun) {
    cleanupResolved(resolved, deps);
    return finalize(options, {
      success: true,
      from: 'beads',
      dryRun: true,
      source: resolved.dir,
      sourceKind: resolved.kind,
      planned,
      gaps,
    });
  }

  try {
    let broker = opts._broker;
    if (!broker) {
      const built = await buildMigratedKernelIssueDeps({ projectRoot });
      broker = built.kernelBroker;
    }
    const summary = await broker.importIssues(kernel, { now });
    cleanupResolved(resolved, deps);
    return finalize(options, {
      success: true,
      from: 'beads',
      dryRun: false,
      source: resolved.dir,
      sourceKind: resolved.kind,
      planned,
      imported: {
        issues: summary.issues,
        comments: summary.comments,
        dependencies: summary.dependencies,
        events: summary.events,
      },
      gaps,
    });
  } catch (err) {
    cleanupResolved(resolved, deps);
    return finalize(
      options,
      { success: false, from: 'beads', source: resolved.dir, error: `Kernel import failed: ${err.message}` },
      1,
    );
  }
}

/**
 * Detect a jsonl-backed Beads store under `<projectRoot>/.beads`. Returns the
 * directory path when it holds *.jsonl sidecars, else null.
 *
 * Onboarding (forge setup/init) uses this to decide whether to auto-migrate.
 * It deliberately never falls back to `bd export` (a Dolt-only store with no
 * jsonl returns null), so setup stays bd-free even when Dolt is down.
 */
function detectBeadsJsonlSource(projectRoot, deps = {}) {
  const fsImpl = deps.fs || fs;
  const beadsDir = path.join(projectRoot || process.cwd(), '.beads');
  return fsImpl.existsSync(beadsDir) && directoryHasJsonl(beadsDir, fsImpl)
    ? beadsDir
    : null;
}

/**
 * Idempotently import an existing jsonl-backed Beads store into the Kernel as
 * part of onboarding. Reuses the exact `forge migrate --from beads` spine, so
 * gaps are surfaced honestly and a second run inserts nothing.
 *
 * No-op (`{ migrated: false, reason: 'no-beads-jsonl' }`) when there is no jsonl
 * `.beads/` present. Never requires the `bd` binary.
 *
 * @param {string} projectRoot
 * @param {object} [opts] - Passed through to runBeadsMigration (_broker/_now/_fs seams).
 * @returns {Promise<{ migrated: boolean, reason?: string, result?: object }>}
 */
async function autoMigrateBeadsIfPresent(projectRoot, opts = {}) {
  if (!detectBeadsJsonlSource(projectRoot, { fs: opts._fs })) {
    return { migrated: false, reason: 'no-beads-jsonl' };
  }
  const result = await runBeadsMigration({ from: 'beads' }, projectRoot, opts);
  return { migrated: result.success === true, result };
}

const BEADS_MIGRATE_NUDGE =
  'Forge could not import your Beads issues into the Kernel automatically. '
  + 'Run `forge migrate --from beads` to import them.';

// The "already imported" marker lives as a row in the broker's kernel_migrations
// ledger (created unconditionally by broker.initialize()), NOT as a file beside the
// DB. Keeping it INSIDE the kernel DB means a DB reset drops the marker and the import
// self-heals; a file sentinel would survive the reset and leave issues dark forever.
// The id uses underscores so it passes the ledger charset /^[0-9a-z_]+$/i and stays
// clear of the tokens the D20 retirement audit counts (see release-readiness.js).
const IMPORT_MARKER_TABLE = 'kernel_migrations';
const IMPORT_MARKER_ID = 'data_import_beads_jsonl';

// Read/record the import marker via the DRIVER (the broker exposes no raw SQL). Both
// calls are param-less (raw SQL + config); the id is a hardcoded constant and appliedAt
// is an ISO string, so interpolation is injection-safe — mirrors broker.recordMigrationSql.
async function importMarkerPresent(driver, config) {
  if (!driver || typeof driver.queryAll !== 'function') {
    return false;
  }
  try {
    const rows = await driver.queryAll(
      `SELECT 1 FROM ${IMPORT_MARKER_TABLE} WHERE id = '${IMPORT_MARKER_ID}' LIMIT 1;`,
      config,
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    // Ledger table absent / driver unavailable → treat as not-yet-imported.
    return false;
  }
}

async function recordImportMarker(driver, config, appliedAt) {
  if (!driver || typeof driver.exec !== 'function') {
    return;
  }
  try {
    await driver.exec(
      `INSERT OR IGNORE INTO ${IMPORT_MARKER_TABLE} (id, applied_at) VALUES ('${IMPORT_MARKER_ID}', '${appliedAt}');`,
      config,
    );
  } catch {
    // Best-effort marker; never break the command we ride on.
  }
}

/**
 * First-use safety net for the kernel default backend. Onboarding auto-migrate runs
 * only from `forge setup`/`init`; an existing repo whose user merely upgrades forge
 * reads an EMPTY kernel on the first issue command, so their existing Beads issues
 * appear to vanish. This imports them ONCE — gated by an in-DB marker row in the
 * kernel_migrations ledger, so the gate shares the DB lifecycle and a DB reset
 * self-heals — idempotently, announcing on stderr only so `--json` stdout stays a pure
 * contract. NEVER throws: the safety net must never break the command it rides on.
 *
 * Only a jsonl-backed store is auto-imported (the migration binary is never shelled).
 * A store with no jsonl export is skipped silently. The marker is SUCCESS-ONLY: a
 * failed import records nothing and is retried (with a nudge) on the next kernel
 * command, so transient failures and DB resets self-heal. Imported issues land in the
 * read model directly and arrive UNCLAIMED — they surface via `forge issue ready`.
 *
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {string} params.databasePath - kernel DB path (used for the driver config).
 * @param {object} params.broker - an initialized kernel broker to import through.
 * @param {object} params.driver - kernel driver, for the ledger marker read/write.
 * @param {object} [deps] - { fs, warn, now, driver, _fs } seams for tests.
 * @returns {Promise<{action:'migrated'|'nudge'|'skip', reason?:string, inserted?:number}>}
 */
async function autoMigrateBeadsAtRuntime({ projectRoot, databasePath, broker, driver } = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const warn = deps.warn || ((msg) => process.stderr.write(`${msg}\n`));
  const appliedAt = deps.now || new Date().toISOString();
  const markerDriver = deps.driver || driver;
  const markerConfig = databasePath ? { databasePath } : {};
  try {
    if (!databasePath) {
      return { action: 'skip', reason: 'no-db-path' };
    }

    // One-time gate: the import already ran on THIS kernel DB (the marker dies with the
    // DB, so deleting kernel.sqlite to reset correctly re-triggers the import).
    if (await importMarkerPresent(markerDriver, markerConfig)) {
      return { action: 'skip', reason: 'already-imported' };
    }

    // Only a jsonl export can be imported automatically; anything else is skipped
    // silently (an empty or export-less store must never trigger a false nudge).
    if (!detectBeadsJsonlSource(projectRoot, { fs: fsImpl })) {
      return { action: 'skip', reason: 'no-jsonl' };
    }

    // Import (idempotent) through the already-initialized broker.
    let outcome;
    try {
      outcome = await autoMigrateBeadsIfPresent(projectRoot, { _broker: broker, _now: deps.now, _fs: deps._fs });
    } catch (err) {
      outcome = { migrated: false, result: { success: false, error: err.message } };
    }

    if (outcome.migrated) {
      const inserted = outcome.result?.imported?.issues?.inserted ?? 0;
      const skipped = outcome.result?.imported?.issues?.skipped ?? 0;
      // Record the marker LAST so a concurrent first run is a benign idempotent skip.
      await recordImportMarker(markerDriver, markerConfig, appliedAt);
      if (inserted > 0) {
        warn(`Forge: imported ${inserted} Beads issue(s) into the Kernel — your issues are here, not lost.`);
      }
      return { action: 'migrated', inserted, skipped };
    }

    // Success-only marker: a failed import records nothing and re-nudges next run,
    // so a transient failure self-heals once the underlying problem is resolved.
    const error = outcome.result?.error || outcome.reason || 'unknown error';
    warn(BEADS_MIGRATE_NUDGE);
    return { action: 'nudge', reason: 'migrate-failed', error };
  } catch (err) {
    // Absolutely never break the command we ride on.
    return { action: 'skip', reason: 'error', error: err.message };
  }
}

module.exports = {
  name: 'migrate',
  description: 'Migrate a Beads issue store into the Forge Kernel, or preview the v2→v3 migration',
  detectBeadsJsonlSource,
  autoMigrateBeadsIfPresent,
  autoMigrateBeadsAtRuntime,
  usage: 'forge migrate --from beads [--dry-run] [--source <dir>] [--json]',
  flags: {
    '--from <source>': 'Migration source. Use "beads" to import a Beads issue store into the Kernel.',
    '--source <dir>': 'Directory of exported beads *.jsonl files (defaults to auto-detecting .beads/). '
      + 'A split .beads layout is tolerated: files missing from the given dir are also read from a '
      + 'backup/ subdir and the parent dir, so events (under .beads/backup/) and interactions '
      + '(at .beads/interactions.jsonl) are both picked up regardless of which you point at.',
    '--dry-run': 'Read + map only; print what WOULD be imported without writing to the Kernel.',
    '--json': 'Emit a structured JSON result (counts + gaps + dryRun flag).',
    '--fixture-corpus': 'v2→v3 PoC only: also dry-run the source-tree v2 fixture corpus when available.',
  },

  async handler(args, flags, projectRoot, opts = {}) {
    const options = parseMigrateOptions(args, flags);
    if (options.errors.length > 0) {
      return finalize(options, { success: false, error: options.errors.join('; ') }, 1);
    }

    // New beads → kernel transport, gated on `--from beads`. Any other (or absent)
    // `--from` falls through to the pre-existing v2→v3 dry-run PoC so its contract
    // (and tests) stay intact.
    if (options.from) {
      if (options.from === 'beads') {
        return runBeadsMigration(options, projectRoot, opts);
      }
      return finalize(
        options,
        { success: false, error: `Unsupported migration source '${options.from}'. Supported sources: beads.` },
        1,
      );
    }

    // --- legacy v2 → v3 dry-run PoC (unchanged) ---
    const dryRun = flags?.dryRun === true || hasArg(args, '--dry-run');
    if (!dryRun) {
      return {
        success: false,
        error: 'Only forge migrate --dry-run is implemented in the Wave 0 PoC.',
      };
    }

    const report = buildMigrationDryRunReport(projectRoot, {
      fixtureCorpus: hasArg(args, '--fixture-corpus'),
    });
    const output = renderMigrationDryRunReport(report);

    return {
      success: report.ok,
      output,
      error: report.ok ? undefined : output,
    };
  },
};
