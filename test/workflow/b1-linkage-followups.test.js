'use strict';

// B1-followup cluster (R1, R2, R3, R4, be18881c) — residuals deferred from the
// merged B1 PR #380. Each test is RED-first against the pre-fix code:
//   R1 (0ea7da6f): two plan-first features from the SAME checkout must not
//     clobber each other's branch->issue linkage (path-keyed upsert bug).
//   be18881c:      a REUSED branch name must resolve to the LIVE issue, not a
//     stale registration (listWorktrees match ignored row state).
//   R2 (9a1e39c1): re-entering dev after validate=done must invalidate validate
//     so ship re-requires a fresh validate (stale-validate pass-through).
//   R3 (e86effdf): a failed branch->issue linkage write must warn (no silent swallow).
//   R4 (d25c18ba): the F4c cross-issue guard's branch resolver must be state-aware
//     (a superseded/stale linkage row must NOT bind the branch).

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  enforceStageEntry,
  resolveActiveIssueId,
} = require('../../lib/workflow/enforce-stage');
const {
  registerBranchIssueLinkage,
  currentBranchIssueFromDriver,
} = require('../../lib/commands/plan');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const TIMEOUT = 15000;
const HEALTHY = { healthy: true, hardStop: false, diagnostics: [] };

describe('B1-followup linkage + stage-gate residuals', () => {
  let tmpDir;
  let driver;
  let broker;
  let projectRoot;
  const issueId = 'forge-b1-followup-1';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-followup-'));
    projectRoot = tmpDir;
    const dbPath = path.join(tmpDir, 'kernel.sqlite');
    driver = createBuiltinSQLiteDriver({ databasePath: dbPath });
    broker = createLocalBroker({
      projectRoot: tmpDir,
      execFileSync: () => path.join(tmpDir, '.git'),
      databasePath: dbPath,
      driver,
    });
    await broker.initialize();
    await broker.runIssueOperation(
      'create',
      ['--id', issueId, '--title', 'B1 followup', '--type', 'task'],
      { now: '2026-07-14T00:00:00.000Z', actor: 'tester' },
    );
  });

  afterEach(() => {
    if (driver) driver.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- R1 -------------------------------------------------------------------
  test('R1: two branches registered from the SAME path both keep their linkage', async () => {
    const sharedPath = path.join(tmpDir, 'checkout');
    driver.registerWorktree({
      path: sharedPath,
      git_common_dir: path.join(sharedPath, '.git'),
      branch: 'feat/alpha',
      issue_id: 'issue-alpha',
      state: 'active',
      registered_at: '2026-07-14T01:00:00.000Z',
    });
    driver.registerWorktree({
      path: sharedPath,
      git_common_dir: path.join(sharedPath, '.git'),
      branch: 'feat/beta',
      issue_id: 'issue-beta',
      state: 'active',
      registered_at: '2026-07-14T02:00:00.000Z',
    });

    // The second registration must NOT clobber the first: switching back to the
    // earlier branch must still resolve to its own issue.
    expect(await resolveActiveIssueId(driver, 'feat/alpha')).toBe('issue-alpha');
    expect(await resolveActiveIssueId(driver, 'feat/beta')).toBe('issue-beta');
  }, TIMEOUT);

  // --- be18881c -------------------------------------------------------------
  test('be18881c: a reused branch name resolves to the LIVE issue, not the stale one', async () => {
    // Old worktree registered feat/foo -> issue-old, then that worktree was
    // deleted and feat/foo recreated (different path) for issue-new. The stale
    // row even carries a NEWER timestamp, so a state-blind newest-first match
    // would wrongly pick it.
    driver.registerWorktree({
      path: path.join(tmpDir, 'wt-old'),
      git_common_dir: path.join(tmpDir, 'wt-old', '.git'),
      branch: 'feat/foo',
      issue_id: 'issue-old',
      state: 'active',
      registered_at: '2026-07-14T10:00:00.000Z',
    });
    driver.registerWorktree({
      path: path.join(tmpDir, 'wt-new'),
      git_common_dir: path.join(tmpDir, 'wt-new', '.git'),
      branch: 'feat/foo',
      issue_id: 'issue-new',
      state: 'active',
      registered_at: '2026-07-14T09:00:00.000Z',
    });

    expect(await resolveActiveIssueId(driver, 'feat/foo')).toBe('issue-new');
  }, TIMEOUT);

  // --- R2 -------------------------------------------------------------------
  test('R2: rework in dev after validate=done re-requires validate before ship', async () => {
    const drive = (stage) => enforceStageEntry({
      commandName: stage,
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    });

    for (const stage of ['plan', 'dev', 'validate']) {
      const step = await drive(stage);
      expect(step.allowed).toBe(true);
      step.recordCompletion();
    }

    // Rework: re-enter dev AFTER validate completed. This must invalidate the
    // stale validate=done row.
    const devAgain = await drive('dev');
    expect(devAgain.allowed).toBe(true);
    devAgain.recordCompletion();

    // ship must now be BLOCKED until validate is re-run.
    await expect(drive('ship')).rejects.toThrow(/validate to be completed/i);

    // Re-run validate → ship reachable again.
    const revalidate = await drive('validate');
    expect(revalidate.allowed).toBe(true);
    revalidate.recordCompletion();

    const ship = await drive('ship');
    expect(ship.allowed).toBe(true);
    expect(ship.stage).toBe('ship');
  }, TIMEOUT);

  // --- R3 -------------------------------------------------------------------
  test('R3: a failed branch->issue linkage write warns (never swallowed silently)', async () => {
    const warnings = [];
    const throwingDriver = {
      registerWorktree() {
        throw new Error('simulated linkage write failure');
      },
    };

    await registerBranchIssueLinkage(
      { kernelDriver: throwingDriver, projectRoot: tmpDir, warn: (m) => warnings.push(m) },
      'feat/linkage-fail',
      'issue-xyz',
    );

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toMatch(/linkage/i);
  }, TIMEOUT);

  // --- R4 -------------------------------------------------------------------
  test('R4: cross-issue guard resolver consults the ACTIVE linkage row for a slug branch', () => {
    const activeDriver = {
      listWorktrees: () => [
        { branch: 'feat/slug-guard', issue_id: 'issue-A', state: 'active' },
      ],
    };
    expect(currentBranchIssueFromDriver(activeDriver, 'feat/slug-guard')).toBe('issue-A');
  });

  test('R4: a superseded/stale linkage row must NOT bind the branch', () => {
    const staleDriver = {
      listWorktrees: () => [
        { branch: 'feat/slug-guard', issue_id: 'issue-A', state: 'superseded' },
      ],
    };
    // No UUID in the branch name, so a state-aware resolver returns null.
    expect(currentBranchIssueFromDriver(staleDriver, 'feat/slug-guard')).toBe(null);
  });
});
