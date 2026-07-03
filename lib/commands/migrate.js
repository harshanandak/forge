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

module.exports = {
  name: 'migrate',
  description: 'Migrate a Beads issue store into the Forge Kernel, or preview the v2→v3 migration',
  usage: 'forge migrate --from beads [--dry-run] [--source <dir>] [--json]',
  flags: {
    '--from <source>': 'Migration source. Use "beads" to import a Beads issue store into the Kernel.',
    '--source <dir>': 'Directory of exported beads *.jsonl files (defaults to auto-detecting .beads/).',
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
