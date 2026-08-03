'use strict';

// P0 kernel-linkage backbone (RED-first). Proves the kernel is the backbone linking
// issue -> worktree -> work-folder:
//   1. `forge worktree create <slug> --issue <id> --work-folder <path>` WRITES a
//      kernel_worktrees row linking worktree(path) <-> issue_id <-> branch <-> work_folder,
//      and drops a machine-readable `.forge-issue` marker in the work-folder.
//   2. Orientation resolves the work-folder from that kernel linkage (not the
//      "most-complete folder" heuristic) when the row exists, and still falls back to
//      the heuristic when it does not.
//
// The worktree's node_modules is a junction to the shared install; git is stubbed so
// no real `git worktree add` runs, but the Kernel SQLite driver is REAL (migrated over a
// temp DB) so the linkage row and orientation read are exercised end-to-end.

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const worktree = require('../../lib/commands/worktree');
const { discoverWorkFolder, buildOrientation } = require('../../lib/orientation');
const { buildMigratedKernelIssueDeps } = require('../../lib/kernel/cli-broker-factory');

const TIMEOUT = 15000;
const cleanups = [];

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// Stub git: report the common-dir + top-level, no existing branch, and swallow the
// `worktree add` (which therefore never creates the worktree directory on disk).
function gitStub(commonDir, topLevel) {
  return (_cmd, args) => {
    const joined = (args || []).join(' ');
    if (joined.includes('rev-parse') && joined.includes('--show-toplevel')) return `${topLevel}\n`;
    if (joined.includes('rev-parse') && joined.includes('--git-common-dir')) return `${commonDir}\n`;
    if (joined.includes('branch') && joined.includes('--list')) return '';
    return '';
  };
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-linkage-'));
  // Keep the kernel dir OUT of `root/.git` so the no-linkage baseline
  // (discoverWorkFolder without an injected driver) takes the "no repo" fast path
  // instead of spawning a real `git` in a non-repo temp dir.
  const gitCommonDir = path.join(root, '.forge-kernel');
  const databasePath = path.join(gitCommonDir, 'kernel.sqlite');
  fs.mkdirSync(gitCommonDir, { recursive: true });

  // Decoy folder is the "most complete" (plan + tasks + decisions) so the folder
  // heuristic would pick it. The linked folder is the LEAST complete (design only) —
  // only the kernel linkage should make orientation choose it.
  writeFile(root, 'docs/work/2026-07-04-decoy/plan.md', '# Plan\n');
  writeFile(root, 'docs/work/2026-07-04-decoy/tasks.md', '# Tasks\n');
  writeFile(root, 'docs/work/2026-07-04-decoy/decisions.md', '# Decisions\n');
  writeFile(root, 'docs/work/2026-07-04-linked/plan.md', '# Linked design\n');

  const deps = await buildMigratedKernelIssueDeps({
    projectRoot: root,
    databasePath,
    gitCommonDir,
  });
  cleanups.push(() => {
    // Close the DB handle BEFORE removing the temp dir, or Windows holds a lock (EBUSY).
    try { deps.kernelDriver.close?.(); } catch { /* ignore */ }
    try { deps.kernelBroker.close?.(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  return { root, gitCommonDir, driver: deps.kernelDriver };
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

describe('P0 kernel linkage: forge worktree create writes kernel_worktrees', () => {
  test('links worktree <-> issue <-> branch <-> work-folder in one row + drops marker', async () => {
    const { root, gitCommonDir, driver } = await setup();
    const worktreePath = path.resolve(root, '.worktrees', 's1');

    const result = await worktree.handler(
      ['create', 's1', '--branch', 'feat/s1', '--issue', 'forge-linktest', '--work-folder', 'docs/work/2026-07-04-linked'],
      {},
      root,
      { _exec: gitStub(gitCommonDir, root), _spawn: () => ({ status: 0 }), _platform: 'linux', _kernelDriver: driver },
    );
    expect(result.success).toBe(true);

    const rows = await driver.queryAll('SELECT * FROM kernel_worktrees');
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.path).toBe(worktreePath);
    expect(row.branch).toBe('feat/s1');
    expect(row.issue_id).toBe('forge-linktest');
    expect(row.work_folder).toBe('docs/work/2026-07-04-linked');
    expect(row.git_common_dir).toBe(path.resolve(gitCommonDir));
    expect(row.state).toBe('active');

    const markerPath = path.join(root, 'docs/work/2026-07-04-linked', '.forge-issue');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8').trim()).toBe('forge-linktest');
  }, TIMEOUT);

  test('worktree list reads the linkage rows from the kernel', async () => {
    const { root, gitCommonDir, driver } = await setup();
    await worktree.handler(
      ['create', 's1', '--branch', 'feat/s1', '--issue', 'forge-linktest'],
      {},
      root,
      { _exec: gitStub(gitCommonDir, root), _spawn: () => ({ status: 0 }), _platform: 'linux', _kernelDriver: driver },
    );

    // git is stubbed so the checkout dir never lands on disk; inject a permissive
    // existsSync so the linked row survives the on-disk staleness filter.
    const list = await worktree.handler(['list'], {}, root, {
      _kernelDriver: driver,
      _fs: { existsSync: () => true },
    });
    expect(list.success).toBe(true);
    expect(Array.isArray(list.worktrees)).toBe(true);
    expect(list.worktrees.some(w => w.issue_id === 'forge-linktest' && w.branch === 'feat/s1')).toBe(true);
    // The CLI dispatcher only prints result.output, so a display command MUST
    // render one — otherwise `forge worktree list` is a silent no-op.
    expect(typeof list.output).toBe('string');
    expect(list.output.length).toBeGreaterThan(0);
    expect(list.output).toContain('feat/s1');

    // Staleness filter: rows whose path no longer exists on disk (removed via
    // `forge worktree remove` / `forge clean`, which don't yet reconcile the
    // registry) must NOT be surfaced.
    const stale = await worktree.handler(['list'], {}, root, {
      _kernelDriver: driver,
      _fs: { existsSync: () => false },
    });
    expect(stale.worktrees).toHaveLength(0);
    expect(stale.output).toBe('No worktrees registered.');
  }, TIMEOUT);

  test('keeps a missing work-folder untouched, then repairs its marker on reuse idempotently', async () => {
    const { root, gitCommonDir, driver } = await setup();
    const worktreePath = path.resolve(root, '.worktrees', 'late-folder');
    const workFolder = 'docs/work/2026-07-05-late';
    const markerPath = path.join(root, workFolder, '.forge-issue');
    const args = ['create', 'late-folder', '--branch', 'feat/late-folder', '--issue', 'forge-late', '--work-folder', workFolder];
    const opts = { _exec: gitStub(gitCommonDir, root), _spawn: () => ({ status: 0 }), _platform: 'linux', _kernelDriver: driver };

    const first = await worktree.handler(args, {}, root, opts);
    expect(first.success).toBe(true);
    expect(fs.existsSync(path.join(root, workFolder))).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);

    const firstRow = (await driver.queryAll('SELECT * FROM kernel_worktrees'))[0];
    expect(firstRow.issue_id).toBe('forge-late');
    expect(firstRow.work_folder).toBe(workFolder);

    fs.mkdirSync(path.join(root, workFolder), { recursive: true });
    fs.mkdirSync(worktreePath, { recursive: true });

    const repaired = await worktree.handler(args, {}, root, opts);
    expect(repaired.success).toBe(true);
    expect(repaired.reused).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8').trim()).toBe('forge-late');

    const rerun = await worktree.handler(args, {}, root, opts);
    expect(rerun.success).toBe(true);
    expect(rerun.reused).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8').trim()).toBe('forge-late');
    const rows = await driver.queryAll('SELECT * FROM kernel_worktrees');
    expect(rows).toHaveLength(1);
    expect(rows[0].issue_id).toBe('forge-late');
    expect(rows[0].work_folder).toBe(workFolder);
  }, TIMEOUT);

  test('rejects mismatched issue or work-folder on reuse without rewriting linkage', async () => {
    const { root, gitCommonDir, driver } = await setup();
    const worktreePath = path.resolve(root, '.worktrees', 'mismatch');
    const workFolder = 'docs/work/2026-07-06-owned';
    const otherFolder = 'docs/work/2026-07-06-other';
    const markerPath = path.join(root, workFolder, '.forge-issue');
    fs.mkdirSync(path.join(root, workFolder), { recursive: true });
    const opts = { _exec: gitStub(gitCommonDir, root), _spawn: () => ({ status: 0 }), _platform: 'linux', _kernelDriver: driver };
    const original = ['create', 'mismatch', '--branch', 'feat/mismatch', '--issue', 'forge-owned', '--work-folder', workFolder];

    const first = await worktree.handler(original, {}, root, opts);
    expect(first.success).toBe(true);
    fs.mkdirSync(worktreePath, { recursive: true });
    const before = await driver.queryAll('SELECT * FROM kernel_worktrees');

    const issueMismatch = await worktree.handler(
      ['create', 'mismatch', '--branch', 'feat/mismatch', '--issue', 'forge-other', '--work-folder', workFolder],
      {}, root, opts,
    );
    expect(issueMismatch.success).toBe(false);
    expect(issueMismatch.error).toMatch(/mismatch/i);

    const folderMismatch = await worktree.handler(
      ['create', 'mismatch', '--branch', 'feat/mismatch', '--issue', 'forge-owned', '--work-folder', otherFolder],
      {}, root, opts,
    );
    expect(folderMismatch.success).toBe(false);
    expect(folderMismatch.error).toMatch(/mismatch/i);
    expect(fs.readFileSync(markerPath, 'utf8').trim()).toBe('forge-owned');
    expect(fs.existsSync(path.join(root, otherFolder))).toBe(false);
    expect(await driver.queryAll('SELECT * FROM kernel_worktrees')).toEqual(before);
  }, TIMEOUT);
});

describe('P0 kernel linkage: orientation resolves work-folder via the kernel', () => {
  test('discoverWorkFolder prefers the kernel-linked folder over the heuristic', async () => {
    const { root, gitCommonDir, driver } = await setup();
    const worktreePath = path.resolve(root, '.worktrees', 's1');

    // Baseline: with no linkage, the heuristic picks the most-complete (decoy) folder.
    expect(discoverWorkFolder(root, {})).toBe(path.resolve(root, 'docs/work/2026-07-04-decoy'));

    await worktree.handler(
      ['create', 's1', '--branch', 'feat/s1', '--issue', 'forge-linktest', '--work-folder', 'docs/work/2026-07-04-linked'],
      {},
      root,
      { _exec: gitStub(gitCommonDir, root), _spawn: () => ({ status: 0 }), _platform: 'linux', _kernelDriver: driver },
    );

    // With the linkage present, orientation resolves the linked folder deterministically.
    const resolved = discoverWorkFolder(root, { _kernelDriver: driver, worktreePath });
    expect(resolved).toBe(path.resolve(root, 'docs/work/2026-07-04-linked'));

    const orientation = buildOrientation(root, { _kernelDriver: driver, worktreePath, budgetTokens: 8000 });
    const workSections = orientation.sections.filter(s => typeof s.work_folder === 'string');
    expect(workSections.length).toBeGreaterThan(0);
    for (const section of workSections) {
      expect(section.work_folder).toBe('docs/work/2026-07-04-linked');
    }
  }, TIMEOUT);
});
