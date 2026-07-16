'use strict';

// F1 (adversarial-review gap): `forge plan` must REGISTER the branch->issue
// linkage so the kernel stage gate can resolve the active issue on a
// plan-created branch. Without it, resolveActiveIssueId returns null →
// dev/validate record nothing → ship dead-ends with "requires authoritative
// workflow state" — the exact blocker this PR claims to fix.
//
// This test drives the REAL plan-first flow: executePlan creates the branch and
// registers the linkage (no hand-registered linkage, and the branch name does
// NOT encode the issue UUID, so the linkage row is the ONLY way to resolve the
// issue). Then it drives enforceStageEntry plan->dev->validate->ship and proves
// ship is reachable.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { executePlan } = require('../../lib/commands/plan.js');
const { enforceStageEntry } = require('../../lib/workflow/enforce-stage.js');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const TIMEOUT = 20000;
const HEALTHY = { healthy: true, hardStop: false, diagnostics: [] };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

describe('F1: plan-first flow reaches ship (branch->issue linkage registered by plan)', () => {
  let repo;
  let driver;
  let broker;
  const issueId = 'kernel-plan-first-1'; // deliberately NOT a UUID → only the linkage row can resolve it

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-first-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env: GIT_ENV });
    fs.mkdirSync(path.join(repo, 'docs', 'research'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'docs', 'research', 'plan-first-demo.md'),
      '# Plan First Demo\n\n**Timeline**: 2 hours\n**Strategic/Tactical**: Tactical\n',
    );

    const dbPath = path.join(repo, 'kernel.sqlite');
    driver = createBuiltinSQLiteDriver({ databasePath: dbPath });
    broker = createLocalBroker({
      projectRoot: repo,
      execFileSync: () => path.join(repo, '.git'),
      databasePath: dbPath,
      driver,
    });
    await broker.initialize();
    await broker.runIssueOperation(
      'create',
      ['--id', issueId, '--title', 'plan first', '--type', 'task'],
      { now: '2026-07-14T00:00:00.000Z', actor: 'tester' },
    );
  });

  afterEach(() => {
    if (driver) driver.close();
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  test('plan links + registers linkage; ship then reachable via kernel', async () => {
    const prevCwd = process.cwd();
    const prevEnv = process.env.FORGE_ISSUE_BACKEND;
    delete process.env.FORGE_ISSUE_BACKEND;
    process.chdir(repo);
    let branch;
    try {
      const planResult = await executePlan('plan first demo', {
        projectRoot: repo,
        issue: issueId,
        driver, // linkage registers into the SAME kernel DB
        runIssueOperation: async (op) => (op === 'show'
          ? { ok: true, command: 'issue.show', data: { id: issueId }, next_commands: [] }
          : { ok: true, data: { id: issueId } }),
      });
      expect(planResult.success).toBe(true);
      expect(planResult.linked).toBe(true);
      branch = planResult.branchName;
      expect(branch).toBe('feat/plan-first-demo'); // no UUID encoded
    } finally {
      process.chdir(prevCwd);
      if (prevEnv === undefined) delete process.env.FORGE_ISSUE_BACKEND;
      else process.env.FORGE_ISSUE_BACKEND = prevEnv;
    }

    // Sanity: the ONLY way to resolve the issue is the linkage row plan wrote.
    const linkRow = (driver.listWorktrees() || []).find(r => r.branch === branch);
    expect(linkRow).toBeTruthy();
    expect(linkRow.issue_id).toBe(issueId);

    // Drive the loop with NO injected issue id — resolve it purely from the
    // branch linkage that plan registered (autoResolveKernel path).
    const drive = (stage) => enforceStageEntry({
      commandName: stage,
      projectRoot: repo,
      kernelDriver: driver,
      branch,
      health: HEALTHY,
    });

    for (const stage of ['plan', 'dev', 'validate']) {
      const step = await drive(stage);
      expect(step.allowed).toBe(true);
      step.recordCompletion();
    }

    const ship = await drive('ship');
    expect(ship.allowed).toBe(true);
    expect(ship.stage).toBe('ship');
    expect(driver.getCurrentStage({ issue_id: issueId }, {}).stage).toBe('ship');
  }, TIMEOUT);
});
