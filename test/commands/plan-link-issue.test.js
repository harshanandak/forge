'use strict';

// B4 — `forge plan --issue <id>` links the EXISTING kernel issue instead of
// creating a duplicate issue (and forking a second branch). Regression guard
// for the live-eval finding where `plan` after `issue create` + `claim`
// silently created a SECOND issue + branch.

const { describe, test, expect } = require('bun:test');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

const { executePlan, handler } = require('../../lib/commands/plan.js');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function makeRepoWithResearch(slug, title) {
  const repo = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-plan-link-'));
  nodeExecFileSync('git', ['init', '-q'], { cwd: repo });
  nodeExecFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env: GIT_ENV });
  nodeFs.mkdirSync(nodePath.join(repo, 'docs', 'research'), { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(repo, 'docs', 'research', `${slug}.md`),
    `# ${title}\n\n**Timeline**: 2 hours\n**Strategic/Tactical**: Tactical\n`,
  );
  return repo;
}

async function withRepo(repo, fn) {
  const prevCwd = process.cwd();
  const prevEnv = process.env.FORGE_ISSUE_BACKEND;
  delete process.env.FORGE_ISSUE_BACKEND; // no signal → resolver defaults to kernel
  process.chdir(repo);
  try {
    // AWAIT the callback: otherwise the finally below restores CWD and deletes
    // the temp repo while the async body is still running (teardown race — git
    // then fails "cannot change to <deleted dir>").
    await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.FORGE_ISSUE_BACKEND;
    else process.env.FORGE_ISSUE_BACKEND = prevEnv;
    nodeFs.rmSync(repo, { recursive: true, force: true });
  }
}

describe('B4: plan --issue links an existing issue instead of forking a new one', () => {
  test('executePlan with an issue id links (never calls create)', async () => {
    const repo = makeRepoWithResearch('link-demo', 'Link Demo');
    const existingId = 'kernel-existing-123';
    const ops = [];
    const fakeRun = async (operation) => {
      ops.push(operation);
      if (operation === 'show') {
        return { ok: true, command: 'issue.show', data: { id: existingId }, next_commands: [] };
      }
      return { ok: true, command: `issue.${operation}`, data: { id: 'FORKED-SHOULD-NOT-HAPPEN' }, next_commands: [] };
    };

    await withRepo(repo, async () => {
      const result = await executePlan('link demo', {
        projectRoot: repo,
        issue: existingId,
        runIssueOperation: fakeRun,
      });

      expect(result.success).toBe(true);
      expect(result.linked).toBe(true);
      expect(result.issueId).toBe(existingId);
      // The whole point: no duplicate issue was created.
      expect(ops).not.toContain('create');
    });
  });

  test('executePlan fails clearly when the linked issue does not exist', async () => {
    const repo = makeRepoWithResearch('missing-demo', 'Missing Demo');
    const fakeRun = async (operation) => {
      if (operation === 'show') return { ok: false, error: 'issue not found' };
      return { ok: true, data: { id: 'should-not-create' } };
    };

    await withRepo(repo, async () => {
      const result = await executePlan('missing demo', {
        projectRoot: repo,
        issue: 'nope-does-not-exist',
        runIssueOperation: fakeRun,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found|does not exist|no such issue/i);
    });
  });

  test('F5: --issue with no value errors and never creates a duplicate', async () => {
    const repo = makeRepoWithResearch('novalue-demo', 'No Value Demo');
    const ops = [];
    const fakeRun = async (operation) => {
      ops.push(operation);
      return { ok: true, data: { id: 'should-not-be-created' } };
    };

    await withRepo(repo, async () => {
      const result = await handler(['novalue demo', '--issue'], {}, repo, { runIssueOperation: fakeRun });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/--issue requires a value/i);
      expect(ops).not.toContain('create');
    });
  });

  test('F4c: refuses to link issue B on a branch already bound to issue A', async () => {
    const repo = makeRepoWithResearch('conflict-demo', 'Conflict Demo');
    const issueA = '11111111-1111-4111-8111-111111111111';
    const issueB = '22222222-2222-4222-8222-222222222222';
    // Sit on a feature branch that encodes issue A.
    nodeExecFileSync('git', ['checkout', '-q', '-b', `feat/${issueA}`], { cwd: repo });
    const fakeRun = async (operation) => (operation === 'show'
      ? { ok: true, data: { id: issueB } }
      : { ok: true, data: { id: issueB } });

    await withRepo(repo, async () => {
      const result = await executePlan('conflict demo', {
        projectRoot: repo,
        issue: issueB,
        runIssueOperation: fakeRun,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already bound to issue/i);
    });
  });

  test('F4c: rejects linking a different issue on a registry-linked NON-UUID branch', async () => {
    // The branch name has no UUID, so ONLY the kernel worktree registry (not the
    // branch-name fallback) can catch the conflict — this is the plan-created
    // slug-branch case CodeRabbit flagged.
    const repo = makeRepoWithResearch('registry-conflict', 'Registry Conflict');
    const issueA = 'kernel-issue-a';
    const issueB = 'kernel-issue-b';
    const branch = 'feat/plain-slug';
    nodeExecFileSync('git', ['checkout', '-q', '-b', branch], { cwd: repo });

    const dbPath = nodePath.join(repo, 'kernel.sqlite');
    const driver = createBuiltinSQLiteDriver({ databasePath: dbPath });
    const broker = createLocalBroker({
      projectRoot: repo,
      execFileSync: () => nodePath.join(repo, '.git'),
      databasePath: dbPath,
      driver,
    });
    await broker.initialize();
    // Link the current (non-UUID) branch to issue A in the kernel registry.
    driver.registerWorktree({
      path: repo,
      git_common_dir: nodePath.join(repo, '.git'),
      branch,
      actor: null,
      issue_id: issueA,
      work_folder: null,
      registered_at: '2026-07-14T00:00:00.000Z',
      state: 'active',
    });

    await withRepo(repo, async () => {
      try {
        const result = await executePlan('registry conflict', {
          projectRoot: repo,
          issue: issueB,
          driver, // consulted by currentBranchIssueFromDriver via listWorktrees
          runIssueOperation: async () => ({ ok: true, data: { id: issueB } }),
        });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/already bound to issue/i);
        expect(result.error).toContain(issueA);
      } finally {
        // Close before withRepo's rmSync so the DB handle is released first.
        driver.close();
      }
    });
  });

  test('handler parses --issue and reports the linked id (no fork)', async () => {
    const repo = makeRepoWithResearch('handler-link', 'Handler Link');
    const existingId = 'kernel-handler-link-1';
    const ops = [];
    const fakeRun = async (operation) => {
      ops.push(operation);
      if (operation === 'show') {
        return { ok: true, command: 'issue.show', data: { id: existingId }, next_commands: [] };
      }
      return { ok: true, data: { id: 'FORKED' } };
    };

    await withRepo(repo, async () => {
      const result = await handler(['handler link', '--issue', existingId], {}, repo, {
        runIssueOperation: fakeRun,
      });

      expect(result.success).toBe(true);
      expect(result.issueId).toBe(existingId);
      expect(ops).not.toContain('create');
      expect(result.output).toMatch(/link/i);
    });
  });
});
