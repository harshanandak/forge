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

function withRepo(repo, fn) {
  const prevCwd = process.cwd();
  const prevEnv = process.env.FORGE_ISSUE_BACKEND;
  delete process.env.FORGE_ISSUE_BACKEND; // no signal → resolver defaults to kernel
  process.chdir(repo);
  try {
    return fn();
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
