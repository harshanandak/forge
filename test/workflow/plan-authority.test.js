'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  reconcilePlanAuthority,
  readPlanSnapshot,
} = require('../../lib/workflow/plan-authority');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { createLocalBroker } = require('../../lib/kernel/broker');

const ISSUE_ID = 'plan-authority-issue';
const WORK_FOLDER = 'docs/work/2026-08-09-plan-authority';
const REPAIR = 'forge plan "plan authority" --issue plan-authority-issue';

describe('Kernel plan authority', () => {
  let root;
  let dbPath;
  let driver;
  let broker;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-authority-'));
    dbPath = path.join(root, 'kernel.sqlite');
    driver = createBuiltinSQLiteDriver({ databasePath: dbPath });
    broker = createLocalBroker({
      projectRoot: root,
      databasePath: dbPath,
      driver,
      execFileSync: () => path.join(root, '.git'),
    });
    await broker.initialize();
    await broker.runIssueOperation(
      'create',
      ['--id', ISSUE_ID, '--title', 'plan authority', '--type', 'bug', '--acceptance', 'materialize plan'],
      { actor: 'test', now: '2026-08-09T00:00:00.000Z' },
    );
  });

  afterEach(() => {
    if (driver) driver.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function writeArtifacts(plan = '# Plan\n', tasks = '# Tasks\n') {
    const folder = path.join(root, WORK_FOLDER);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'plan.md'), plan, 'utf8');
    fs.writeFileSync(path.join(folder, 'tasks.md'), tasks, 'utf8');
  }

  test('fresh plan atomically persists a versioned snapshot and plan-to-dev transition', () => {
    writeArtifacts('# Plan\nFresh\n', '# Tasks\n- One\n');

    const result = reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
    });

    expect(result.status).toBe('captured');
    const snapshot = readPlanSnapshot(driver, ISSUE_ID);
    expect(snapshot.schema).toBe('forge.plan.v1');
    expect(snapshot.artifacts.map((entry) => entry.path)).toEqual([
      `${WORK_FOLDER}/plan.md`,
      `${WORK_FOLDER}/tasks.md`,
    ]);
    expect(snapshot.artifacts[0].content).toBe('# Plan\nFresh\n');
    expect(snapshot.artifacts[0].sha256).toHaveLength(64);
    expect(driver.getCurrentStage({ issue_id: ISSUE_ID }, {}).stage).toBe('dev');
  });

  test('resumed session verifies the authoritative snapshot without rewriting files', () => {
    writeArtifacts();
    reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
    });
    const before = fs.statSync(path.join(root, WORK_FOLDER, 'plan.md')).mtimeMs;

    const result = reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, mode: 'dev', repairCommand: REPAIR,
    });

    expect(result.status).toBe('verified');
    expect(fs.statSync(path.join(root, WORK_FOLDER, 'plan.md')).mtimeMs).toBe(before);
  });

  test('Kernel-only state deterministically materializes both missing artifacts', () => {
    writeArtifacts('# Plan\nKernel\n', '# Tasks\n- Restore\n');
    reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
    });
    fs.rmSync(path.join(root, WORK_FOLDER), { recursive: true, force: true });

    const result = reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, mode: 'dev', repairCommand: REPAIR,
    });

    expect(result.status).toBe('materialized');
    expect(fs.readFileSync(path.join(root, WORK_FOLDER, 'plan.md'), 'utf8')).toBe('# Plan\nKernel\n');
    expect(fs.readFileSync(path.join(root, WORK_FOLDER, 'tasks.md'), 'utf8')).toBe('# Tasks\n- Restore\n');
  });

  test('drift fails closed, preserves divergent bytes, and gives one repair path', () => {
    writeArtifacts();
    reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
    });
    const planPath = path.join(root, WORK_FOLDER, 'plan.md');
    fs.writeFileSync(planPath, '# Diverged\n', 'utf8');

    expect(() => reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, mode: 'dev', repairCommand: REPAIR,
    })).toThrow(`Plan artifacts drifted from Kernel authority. Reconcile the files, then run: ${REPAIR}`);
    expect(fs.readFileSync(planPath, 'utf8')).toBe('# Diverged\n');
  });

  test('noninteractive execution fails early when neither Kernel nor repository has a plan', () => {
    expect(() => reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'dev', repairCommand: REPAIR,
    })).toThrow(`Plan authority is missing. Create plan.md and tasks.md, then run: ${REPAIR}`);
  });

  test.skipIf(process.platform === 'win32')('capture rejects a portable symlink artifact that escapes the repository', () => {
    const folder = path.join(root, WORK_FOLDER);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-outside-'));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(outside, 'plan.md'), '# Outside\n', 'utf8');
    fs.symlinkSync(path.join(outside, 'plan.md'), path.join(folder, 'plan.md'));
    fs.writeFileSync(path.join(folder, 'tasks.md'), '# Tasks\n', 'utf8');
    try {
      expect(() => reconcilePlanAuthority({
        driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
      })).toThrow('Plan artifact path contains a symbolic link or reparse point');
      expect(readPlanSnapshot(driver, ISSUE_ID)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'win32')('materialization rejects a Windows junction ancestor and writes nothing outside', () => {
    writeArtifacts('# Plan\nKernel\n', '# Tasks\n- Safe\n');
    reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
    });
    fs.rmSync(path.join(root, WORK_FOLDER), { recursive: true, force: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-junction-'));
    fs.mkdirSync(path.dirname(path.join(root, WORK_FOLDER)), { recursive: true });
    fs.symlinkSync(outside, path.join(root, WORK_FOLDER), 'junction');
    try {
      expect(() => reconcilePlanAuthority({
        driver, issueId: ISSUE_ID, projectRoot: root, mode: 'dev', repairCommand: REPAIR,
      })).toThrow('Plan artifact path contains a symbolic link or reparse point');
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(path.join(root, WORK_FOLDER), { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('identical snapshot persistence is transactionally idempotent', async () => {
    writeArtifacts();
    const first = reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
    });
    const issueAfterFirst = await driver.loadKernelEntity('issue', ISSUE_ID);
    const eventsAfterFirst = await driver.listKernelEvents('issue', ISSUE_ID);

    const repeated = driver.recordPlanSnapshotTransition({ issue_id: ISSUE_ID, snapshot: first.snapshot }, {});

    expect(repeated.idempotent).toBe(true);
    expect(driver.listStageRuns({ issue_id: ISSUE_ID }, {})).toHaveLength(2);
    expect((await driver.loadKernelEntity('issue', ISSUE_ID)).entity_revision).toBe(issueAfterFirst.entity_revision);
    expect(await driver.listKernelEvents('issue', ISSUE_ID)).toHaveLength(eventsAfterFirst.length);
  });

  test('a competing driver cannot replace an established snapshot with a different digest', () => {
    writeArtifacts();
    reconcilePlanAuthority({
      driver, issueId: ISSUE_ID, projectRoot: root, workFolder: WORK_FOLDER, mode: 'plan', repairCommand: REPAIR,
    });
    const established = readPlanSnapshot(driver, ISSUE_ID);
    const peer = createBuiltinSQLiteDriver({ databasePath: dbPath });
    const divergent = {
      ...established,
      digest: 'f'.repeat(64),
      artifacts: established.artifacts.map((artifact, index) => index === 0
        ? { ...artifact, content: '# Different\n', sha256: 'e'.repeat(64) }
        : artifact),
    };
    try {
      expect(() => peer.recordPlanSnapshotTransition({ issue_id: ISSUE_ID, snapshot: divergent }, {}))
        .toThrow('Kernel plan snapshot is immutable');
      expect(readPlanSnapshot(driver, ISSUE_ID)).toEqual(established);
      expect(driver.listStageRuns({ issue_id: ISSUE_ID }, {})).toHaveLength(2);
    } finally {
      peer.close();
    }
  });
});
