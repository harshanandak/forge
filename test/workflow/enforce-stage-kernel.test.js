'use strict';

// B1 — kernel is the source of truth for workflow stage state.
//
// These tests prove the #1 beta blocker is fixed: a pure-CLI
// plan -> dev -> validate -> ship progression reaches `ship` WITHOUT any
// Claude slash-command layer ever writing `.forge-state.json`. The kernel
// `stage_runs` registry (written at the enforcement chokepoint) is the only
// durable state, and `ship`'s enforcement reads it back and synthesizes
// authoritative workflow state.
//
// The driver is injected (kernelDriver) so no git repo or bd is required.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enforceStageEntry } = require('../../lib/workflow/enforce-stage');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const TIMEOUT = 15000;

// A runtime-health fixture that never hard-stops, so these tests isolate the
// workflow-state logic (health prerequisites are covered elsewhere).
const HEALTHY = { healthy: true, hardStop: false, diagnostics: [] };

describe('B1: enforceStageEntry uses the kernel as stage-state authority', () => {
  let tmpDir;
  let driver;
  let broker;
  let projectRoot;
  const issueId = 'forge-b1-kernel-1';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-kernel-'));
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
      ['--id', issueId, '--title', 'B1 kernel stage authority', '--type', 'task'],
      { now: '2026-07-14T00:00:00.000Z', actor: 'tester' },
    );
  });

  afterEach(() => {
    if (driver) driver.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ship is REACHABLE from kernel stage state with no .forge-state.json', async () => {
    // Simulate what plan/dev/validate wrote at the chokepoint: the kernel now
    // records the current stage as `validate`. No .forge-state.json exists.
    driver.recordStageRun({ issue_id: issueId, stage: 'validate', action: 'complete' }, {});
    expect(fs.existsSync(path.join(projectRoot, '.forge-state.json'))).toBe(false);

    const result = await enforceStageEntry({
      commandName: 'ship',
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    });

    expect(result.allowed).toBe(true);
    expect(result.stage).toBe('ship');
  }, TIMEOUT);

  test('entering a stage RECORDS it into the kernel (reliable write at the chokepoint)', async () => {
    const result = await enforceStageEntry({
      commandName: 'validate',
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    });
    expect(result.allowed).toBe(true);

    const current = driver.getCurrentStage({ issue_id: issueId }, {});
    expect(current).toBeTruthy();
    expect(current.stage).toBe('validate');
  }, TIMEOUT);

  test('full pure-CLI loop plan->dev->validate->ship reaches ship via kernel only', async () => {
    for (const stage of ['plan', 'dev', 'validate']) {
      const step = await enforceStageEntry({
        commandName: stage,
        projectRoot,
        kernelDriver: driver,
        activeIssueId: issueId,
        health: HEALTHY,
      });
      expect(step.allowed).toBe(true);
      // Simulate the command runner recording completion on handler success, so
      // the stage counts as 'done' (which is what unlocks ship).
      step.recordCompletion();
    }

    // The kernel — not a .forge-state.json file — carries the progression.
    expect(fs.existsSync(path.join(projectRoot, '.forge-state.json'))).toBe(false);
    expect(driver.getCurrentStage({ issue_id: issueId }, {}).stage).toBe('validate');

    const ship = await enforceStageEntry({
      commandName: 'ship',
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    });
    expect(ship.allowed).toBe(true);
    expect(ship.stage).toBe('ship');
    expect(driver.getCurrentStage({ issue_id: issueId }, {}).stage).toBe('ship');
  }, TIMEOUT);

  test('resolves the active issue from the branch->issue worktree linkage (no explicit id)', async () => {
    const branch = 'feat/some-named-branch';
    driver.registerWorktree({
      path: projectRoot,
      git_common_dir: path.join(projectRoot, '.git'),
      branch,
      issue_id: issueId,
      actor: 'tester',
      registered_at: '2026-07-14T00:00:00.000Z',
      state: 'active',
    });
    driver.recordStageRun({ issue_id: issueId, stage: 'validate', action: 'complete' }, {});

    const result = await enforceStageEntry({
      commandName: 'ship',
      projectRoot,
      kernelDriver: driver,
      branch, // resolver maps branch -> issue via the linkage registry
      health: HEALTHY,
    });
    expect(result.allowed).toBe(true);
  }, TIMEOUT);

  test('resolves the active issue when the branch name encodes a UUID', async () => {
    const uuidIssue = '11111111-2222-4333-8444-555566667777';
    await broker.runIssueOperation(
      'create',
      ['--id', uuidIssue, '--title', 'uuid-encoded branch issue', '--type', 'task'],
      { now: '2026-07-14T00:00:00.000Z', actor: 'tester' },
    );
    driver.recordStageRun({ issue_id: uuidIssue, stage: 'validate', action: 'complete' }, {});

    const result = await enforceStageEntry({
      commandName: 'ship',
      projectRoot,
      kernelDriver: driver,
      branch: `feat/${uuidIssue}`,
      health: HEALTHY,
    });
    expect(result.allowed).toBe(true);
  }, TIMEOUT);

  test('F3: entering (not completing) validate does NOT unlock ship', async () => {
    // validate started but never completed (e.g. validation failed).
    driver.recordStageRun({ issue_id: issueId, stage: 'validate', action: 'start' }, {});

    await expect(enforceStageEntry({
      commandName: 'ship',
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    })).rejects.toThrow(/validate to be completed/i);
  }, TIMEOUT);

  test('F2: dev is re-entrant after validate is recorded (dev<->validate loop)', async () => {
    // A common iteration: validate runs, fails, agent re-runs dev.
    driver.recordStageRun({ issue_id: issueId, stage: 'validate', action: 'start' }, {});

    const result = await enforceStageEntry({
      commandName: 'dev',
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    });
    expect(result.allowed).toBe(true);
    expect(result.stage).toBe('dev');
  }, TIMEOUT);

  test('B4: dev runs kernel-primary with no Beads DB present (does not dead-end)', async () => {
    // The tmp project has only a kernel DB — no .beads/ directory at all.
    expect(fs.existsSync(path.join(projectRoot, '.beads'))).toBe(false);

    const result = await enforceStageEntry({
      commandName: 'dev',
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    });

    expect(result.allowed).toBe(true);
    expect(result.stage).toBe('dev');
    expect(driver.getCurrentStage({ issue_id: issueId }, {}).stage).toBe('dev');
  }, TIMEOUT);

  test('still hard-blocks ship when the kernel has NO recorded stage (fail-closed)', async () => {
    // No stage recorded, no .forge-state.json, no inline state → nothing durable
    // says we progressed, so ship must not silently pass.
    await expect(enforceStageEntry({
      commandName: 'ship',
      projectRoot,
      kernelDriver: driver,
      activeIssueId: issueId,
      health: HEALTHY,
    })).rejects.toThrow(/authoritative workflow state/i);
  }, TIMEOUT);
});
