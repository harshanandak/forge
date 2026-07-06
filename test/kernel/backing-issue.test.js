'use strict';

// Unit tests for the ensureBackingIssue() primitive (PR1 of auto-kernel-tracking).
// The primitive is fully injectable: it talks to a kernel `driver` + `broker` that
// these tests supply as light in-memory fakes, so no real git repo / sqlite DB is
// required. The fakes mirror the real method surface (sqlite-driver.js worktree
// registry + broker.runIssueOperation('create', ...)).

const { describe, test, expect } = require('bun:test');

const { ensureBackingIssue } = require('../../lib/kernel/backing-issue');

const TIMEOUT = 5000;

// Parse the argv-style flag pairs the primitive passes to runIssueOperation, the
// same way the real broker's parseFlagPairs does (supports `--k v` and `--k=v`).
function parseArgv(args = []) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      flags[body] = args[index + 1];
      index += 1;
    }
  }
  return flags;
}

// In-memory stand-in for { driver, broker }. worktrees[] mirrors kernel_worktrees
// (upsert-by-path), issues holds created stubs, createLog counts create events.
function makeFakeKernel() {
  const worktrees = [];
  const issues = new Map();
  const createLog = [];

  const driver = {
    listWorktrees() {
      return worktrees.slice().reverse();
    },
    getWorktreeLinkage(filter = {}) {
      for (let i = worktrees.length - 1; i >= 0; i -= 1) {
        if (worktrees[i].path === filter.path) return worktrees[i];
      }
      return null;
    },
    registerWorktree(payload) {
      const idx = worktrees.findIndex(row => row.path === payload.path);
      const base = idx >= 0 ? worktrees[idx] : { id: `wt-${worktrees.length + 1}` };
      const row = { ...base, ...payload };
      if (idx >= 0) worktrees[idx] = row;
      else worktrees.push(row);
      return row;
    },
    async loadKernelEntity(entityType, entityId) {
      if (entityType !== 'issue') return null;
      return issues.has(entityId) ? { entity_id: entityId, entity_revision: 1 } : null;
    },
  };

  const broker = {
    async runIssueOperation(operation, args = []) {
      if (operation !== 'create') return { ok: false };
      const flags = parseArgv(args);
      const id = flags.id;
      const labels = (flags.label || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
      issues.set(id, { id, title: flags.title, body: flags.body, labels, type: flags.type, status: flags.status });
      createLog.push(id);
      return { ok: true, data: { id } };
    },
  };

  return { driver, broker, worktrees, issues, createLog };
}

const BASE = {
  projectRoot: '/repo',
  worktreePath: '/repo/.worktrees/x',
  gitCommonDir: '/repo/.git',
};

describe('ensureBackingIssue', () => {
  test('idempotent: a second call returns the same issue and creates no duplicate', async () => {
    const k = makeFakeKernel();
    const opts = { ...BASE, branch: 'feat/add-widget', driver: k.driver, broker: k.broker, generateId: () => 'issue-1' };

    const first = await ensureBackingIssue(opts);
    const second = await ensureBackingIssue(opts);

    expect(first.issueId).toBe('issue-1');
    expect(first.created).toBe(true);
    expect(second.issueId).toBe('issue-1');
    expect(second.created).toBe(false);
    expect(k.createLog.length).toBe(1);
    expect(k.worktrees.filter(row => row.issue_id === 'issue-1').length).toBe(1);
  }, TIMEOUT);

  test('skips main/master without creating an issue', async () => {
    for (const branch of ['main', 'master']) {
      const k = makeFakeKernel();
      const result = await ensureBackingIssue({ ...BASE, branch, driver: k.driver, broker: k.broker });
      expect(result).toBeNull();
      expect(k.createLog.length).toBe(0);
    }
  }, TIMEOUT);

  test('skips detached HEAD (no branch) without creating an issue', async () => {
    for (const branch of ['HEAD', '', null, undefined]) {
      const k = makeFakeKernel();
      const result = await ensureBackingIssue({ ...BASE, branch, driver: k.driver, broker: k.broker });
      expect(result).toBeNull();
      expect(k.createLog.length).toBe(0);
    }
  }, TIMEOUT);

  test('skips ignore-glob branches (tmp/spike/wip/throwaway)', async () => {
    for (const branch of ['tmp/foo', 'spike/bar', 'wip/baz', 'throwaway/qux']) {
      const k = makeFakeKernel();
      const result = await ensureBackingIssue({ ...BASE, branch, driver: k.driver, broker: k.broker });
      expect(result).toBeNull();
      expect(k.createLog.length).toBe(0);
    }
  }, TIMEOUT);

  test('degrades gracefully (returns null, never throws) when the kernel is unavailable', async () => {
    // No driver/broker at all.
    const missing = await ensureBackingIssue({ ...BASE, branch: 'feat/x' });
    expect(missing).toBeNull();

    // Driver/broker present but every call throws (e.g. locked DB / offline).
    const throwingDriver = {
      listWorktrees() { throw new Error('db down'); },
      getWorktreeLinkage() { throw new Error('db down'); },
      registerWorktree() { throw new Error('db down'); },
      async loadKernelEntity() { throw new Error('db down'); },
    };
    const throwingBroker = { async runIssueOperation() { throw new Error('db down'); } };
    const degraded = await ensureBackingIssue({ ...BASE, branch: 'feat/x', driver: throwingDriver, broker: throwingBroker });
    expect(degraded).toBeNull();
  }, TIMEOUT);

  test('the created stub carries the auto-stub label', async () => {
    const k = makeFakeKernel();
    const result = await ensureBackingIssue({
      ...BASE,
      branch: 'feat/add-widget',
      driver: k.driver,
      broker: k.broker,
      generateId: () => 'issue-2',
    });
    expect(result.created).toBe(true);
    expect(k.issues.get('issue-2').labels).toContain('auto-stub');
  }, TIMEOUT);

  test('persists a readable branch -> issue link (kernel_worktrees.issue_id)', async () => {
    const k = makeFakeKernel();
    await ensureBackingIssue({
      ...BASE,
      branch: 'feat/add-widget',
      driver: k.driver,
      broker: k.broker,
      generateId: () => 'issue-3',
    });
    const row = k.driver.getWorktreeLinkage({ path: BASE.worktreePath });
    expect(row).toBeTruthy();
    expect(row.issue_id).toBe('issue-3');
    expect(row.branch).toBe('feat/add-widget');
  }, TIMEOUT);

  test('dedupes to an existing issue encoded in the branch name instead of creating a stub', async () => {
    const k = makeFakeKernel();
    k.issues.set('kap-7', { id: 'kap-7', labels: [] });
    const result = await ensureBackingIssue({
      ...BASE,
      branch: 'feat/kap-7-add-widget',
      driver: k.driver,
      broker: k.broker,
      generateId: () => 'should-not-be-used',
    });
    expect(result.issueId).toBe('kap-7');
    expect(result.created).toBe(false);
    expect(k.createLog.length).toBe(0);
    expect(k.driver.getWorktreeLinkage({ path: BASE.worktreePath }).issue_id).toBe('kap-7');
  }, TIMEOUT);
});
