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
  let driver;
  let broker;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-authority-'));
    const dbPath = path.join(root, 'kernel.sqlite');
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
});
