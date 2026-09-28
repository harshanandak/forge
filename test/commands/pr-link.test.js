'use strict';

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const pr = require('../../lib/commands/pr');
const merge = require('../../lib/commands/merge');

const ISSUE = '619e1cd4-b5b0-4524-b1d6-793bf395cad8';
const OTHER_ISSUE = '36230258-7b64-4de0-8683-fd8b8eabab51';
const HEAD = 'a'.repeat(40);
const ROOT = path.resolve('C:/repo/.worktrees/feature');
const COMMON = path.resolve('C:/repo/.git');
const BRANCH = 'feat/existing-pr';
const REPO = 'acme/product';
const NUL = String.fromCharCode(0);

function buildHarness(overrides = {}) {
  let persisted = overrides.existingPr || null;
  let upserts = 0;
  let reads = 0;
  const readKeys = [];
  const worktrees = overrides.worktrees || [{
    id: 'WT-1',
    path: ROOT,
    git_common_dir: COMMON,
    branch: BRANCH,
    issue_id: ISSUE,
    state: 'active',
  }];
  const execFileSync = (bin, args, options) => {
    if (overrides.execOptions) overrides.execOptions.push({ bin, options });
    const key = `${bin} ${args.join(' ')}`;
    if (key === 'git rev-parse --show-toplevel') return `${ROOT}\n`;
    if (key === 'git branch --show-current') return `${BRANCH}\n`;
    if (key === 'git rev-parse HEAD') return `${overrides.localHead || HEAD}\n`;
    if (key === 'git rev-parse --path-format=absolute --git-common-dir') {
      return `${overrides.commonDirOutput || COMMON}\n`;
    }
    if (key === 'git worktree list --porcelain -z') {
      if (overrides.inventoryFailure) throw new Error('git worktree list failed');
      const live = overrides.liveWorktrees || [
        { path: path.dirname(COMMON), branch: 'master' },
        { path: ROOT, branch: BRANCH },
      ];
      return live.map(entry => [
        `worktree ${entry.path.split(path.sep).join('/')}`, `HEAD ${HEAD}`, `branch refs/heads/${entry.branch}`,
        ...(entry.prunable ? ['prunable gitdir file points to non-existent location'] : []), '',
      ].join(NUL)).join(NUL);
    }
    if (key === 'gh repo view --json nameWithOwner,isFork,parent') {
      return JSON.stringify({ nameWithOwner: REPO, isFork: false, parent: null });
    }
    if (key.startsWith('gh pr view 42 --repo acme/product --json ')) {
      return JSON.stringify({
        number: 42,
        state: 'OPEN',
        headRefName: BRANCH,
        headRefOid: overrides.remoteHead || HEAD,
        headRepository: { nameWithOwner: overrides.headRepository ?? REPO },
        isCrossRepository: overrides.crossRepository || false,
      });
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const broker = {
    listOpenPrs: async (gitCommonDir) => {
      reads += 1;
      readKeys.push(gitCommonDir);
      if (overrides.openPrRows) return overrides.openPrRows;
      if (overrides.readBackFailure && upserts > 0) return [];
      return persisted ? [persisted] : [];
    },
    upsertPr: async (row) => {
      upserts += 1;
      persisted = {
        ...(persisted || {}),
        ...row,
        issue_id: persisted?.issue_id || row.issue_id,
        worktree_id: persisted?.worktree_id || row.worktree_id,
        journal_ptr: persisted?.journal_ptr || null,
        state: 'open',
      };
      return { ok: true, ...persisted };
    },
  };
  const driver = { listWorktrees: () => worktrees };
  const env = overrides.env || { FORGE_ACTOR: 'release-actor', FORGE_SESSION_ID: 'release-session' };
  const opts = {
    env,
    _execFileSync: execFileSync,
    _verifyIssueOwnership: async () => overrides.owned === false
      ? { owned: false }
      : {
        owned: true,
        actor: env.FORGE_ACTOR || env.FORGE_SESSION_ID,
        claimedBy: env.FORGE_ACTOR || env.FORGE_SESSION_ID,
        sessionId: env.FORGE_SESSION_ID || null,
        expired: false,
      },
    kernelBroker: broker,
    kernelDriver: driver,
    _now: () => new Date('2026-08-23T12:00:00.000Z'),
  };
  return {
    opts,
    broker,
    driver,
    calls: () => ({ upserts, reads, readKeys, persisted }),
  };
}

async function link(harness, args = ['link', '42', '--issue', ISSUE, '--expect-head', HEAD]) {
  return pr.handler(args, {}, ROOT, harness.opts);
}

describe('forge pr link', () => {
  test('bounds every git and gh probe with the calibrated external-I/O timeout', async () => {
    const execOptions = [];
    const harness = buildHarness({ execOptions });

    expect((await link(harness)).success).toBe(true);
    expect(new Set(execOptions.map(call => call.bin))).toEqual(new Set(['git', 'gh']));
    expect(new Set(execOptions.map(call => call.options.timeout))).toEqual(new Set([120_000]));
  });

  test('routes both GitHub probes through the bound GitHub account runner', async () => {
    const execOptions = [];
    const harness = buildHarness({ execOptions });
    const raw = harness.opts._execFileSync;
    harness.opts._execFileSync = (bin, args, options) => {
      if (bin === 'gh') throw new Error('raw gh must not run under a bound GitHub account');
      return raw(bin, args, options);
    };
    const bound = [];
    harness.opts.githubContext = {
      bound: true,
      runGh: (args, options) => {
        bound.push({ args, options });
        return raw('gh', args, options);
      },
    };

    const result = await link(harness);

    expect(result.success).toBe(true);
    expect(bound.map(call => call.args.slice(0, 2))).toEqual([['repo', 'view'], ['pr', 'view']]);
    expect(new Set(bound.map(call => call.options.timeout))).toEqual(new Set([120_000]));
    expect(bound.every(call => call.options.cwd === ROOT)).toBe(true);
    expect(pr.githubAuth(['link', '42', '--issue', ISSUE, '--expect-head', HEAD])).toBe(true);
  }, 10_000);

  test('is registered on the real public CLI surface', () => {
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../bin/forge.js'), 'pr', '--help',
    ], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('forge pr <link|ship|preflight|shepherd|merge>');
  });

  test('binds an existing open PR to the exact active worktree issue', async () => {
    const harness = buildHarness();

    const result = await link(harness);

    expect(result).toMatchObject({
      success: true,
      linked: true,
      repository: REPO,
      pr: 42,
      issueId: ISSUE,
      branch: BRANCH,
      headSha: HEAD,
      worktreeId: 'WT-1',
    });
    expect(harness.calls().upserts).toBe(1);
    expect(harness.calls().persisted).toMatchObject({
      repo: REPO,
      number: 42,
      issue_id: ISSUE,
      worktree_id: 'WT-1',
      state: 'open',
    });
  });

  test('normalizes the git common directory before every Kernel read and write', async () => {
    const rawCommonDir = process.platform === 'win32'
      ? COMMON.replaceAll('\\', '/')
      : `${COMMON}${path.sep}.`;
    const harness = buildHarness({ commonDirOutput: rawCommonDir });

    expect((await link(harness)).success).toBe(true);

    expect(harness.calls().readKeys).toEqual([COMMON, COMMON]);
    expect(harness.calls().persisted.git_common_dir).toBe(COMMON);
  });

  test('is idempotent and preserves existing linkage metadata', async () => {
    const existingPr = {
      git_common_dir: COMMON,
      repo: REPO,
      number: 42,
      issue_id: ISSUE,
      worktree_id: 'WT-1',
      branch: BRANCH,
      head_sha: HEAD,
      state: 'open',
      journal_ptr: 'journal/existing.jsonl',
    };
    const harness = buildHarness({ existingPr });

    expect((await link(harness)).success).toBe(true);
    expect((await link(harness)).success).toBe(true);

    expect(harness.calls().upserts).toBe(2);
    expect(harness.calls().persisted.journal_ptr).toBe('journal/existing.jsonl');
  });

  test('produces the exact open binding required by guarded merge', async () => {
    const harness = buildHarness();
    expect((await link(harness)).success).toBe(true);

    const binding = await merge.defaultVerifyPrIssueBinding({
      issueId: ISSUE,
      pr: '42',
      projectRoot: ROOT,
      prContext: { number: 42, repository: REPO },
      buildBroker: async () => ({
        gitCommonDir: COMMON,
        broker: harness.broker,
        driver: harness.driver,
      }),
    });

    expect(binding).toMatchObject({
      bound: true,
      repository: REPO,
      number: 42,
      issueId: ISSUE,
      branch: BRANCH,
    });
  });

  test('refuses an oversized open-PR registry before writing', async () => {
    const openPrRows = Array.from({ length: 10_001 }, (_, index) => ({
      git_common_dir: COMMON,
      repo: REPO,
      number: index + 1,
      state: 'open',
    }));
    const harness = buildHarness({ openPrRows });

    const result = await link(harness);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/oversized/i);
    expect(harness.calls().upserts).toBe(0);
  });

  test('refuses a PR head that drifted from the exact expected head', async () => {
    const harness = buildHarness({ remoteHead: 'b'.repeat(40) });

    const result = await link(harness);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/head/i);
    expect(harness.calls().upserts).toBe(0);
  });

  test('refuses a worktree linked to a different issue', async () => {
    const harness = buildHarness({
      worktrees: [{
        id: 'WT-1', path: ROOT, git_common_dir: COMMON, branch: BRANCH,
        issue_id: OTHER_ISSUE, state: 'active',
      }],
    });

    const result = await link(harness);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/different issue|exact issue/i);
    expect(harness.calls().upserts).toBe(0);
  });

  test('resolves a short stored worktree issue id to the canonical full UUID', async () => {
    const shortRow = (issueId) => [{
      id: 'WT-1', path: ROOT, git_common_dir: COMMON, branch: BRANCH, issue_id: issueId, state: 'active',
    }];
    const withLookup = (harness, candidates) => {
      harness.driver.findIssueIdsByPrefix = (prefix) => candidates.filter(row => row.id.startsWith(prefix));
      return harness;
    };

    const unique = withLookup(buildHarness({ worktrees: shortRow(ISSUE.slice(0, 8)) }), [{ id: ISSUE }]);
    expect((await link(unique)).success).toBe(true);
    expect(unique.calls().persisted.issue_id).toBe(ISSUE);

    const sibling = `${ISSUE.slice(0, 8)}-0000-4000-8000-000000000000`;
    const ambiguous = withLookup(
      buildHarness({ worktrees: shortRow(ISSUE.slice(0, 8)) }), [{ id: ISSUE }, { id: sibling }],
    );
    const ambiguousResult = await link(ambiguous);
    expect(ambiguousResult.success).toBe(false);
    expect(ambiguous.calls().upserts).toBe(0);

    const unknown = withLookup(buildHarness({ worktrees: shortRow('deadbeef') }), [{ id: ISSUE }]);
    expect((await link(unknown)).success).toBe(false);
    expect(unknown.calls().upserts).toBe(0);

    const different = withLookup(
      buildHarness({ worktrees: shortRow(OTHER_ISSUE.slice(0, 8)) }), [{ id: ISSUE }, { id: OTHER_ISSUE }],
    );
    const differentResult = await link(different);
    expect(differentResult.success).toBe(false);
    expect(differentResult.error).toMatch(/different issue/i);
    expect(different.calls().upserts).toBe(0);
  }, 10_000);

  test('refuses without exact live actor and session ownership', async () => {
    const harness = buildHarness({ owned: false });

    const result = await link(harness);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ownership|claim/i);
    expect(harness.calls().upserts).toBe(0);
  });

  test('accepts an exact actor-owned sessionless claim like guarded merge', async () => {
    const harness = buildHarness({ env: { FORGE_ACTOR: 'release-actor' } });

    const result = await link(harness);

    expect(result.success).toBe(true);
    expect(harness.calls().upserts).toBe(1);
  });

  test('refuses ambiguous active worktree rows for the current path or branch', async () => {
    const row = {
      path: ROOT, git_common_dir: COMMON, branch: BRANCH, issue_id: ISSUE, state: 'active',
    };
    const harness = buildHarness({ worktrees: [{ id: 'WT-1', ...row }, { id: 'WT-2', ...row }] });

    const result = await link(harness);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ambiguous/i);
    expect(harness.calls().upserts).toBe(0);
  });

  test('ignores stale Kernel worktree rows absent from the live git inventory', async () => {
    const live = { id: 'WT-1', path: ROOT, git_common_dir: COMMON, branch: BRANCH, issue_id: ISSUE, state: 'active' };
    const stalePath = path.resolve('C:/repo/.worktrees/removed');
    const stale = { ...live, id: 'WT-STALE', path: stalePath };
    const staleSameRoot = { ...live, id: 'WT-OLD-BRANCH', branch: 'feat/old' };

    const harness = buildHarness({ worktrees: [stale, staleSameRoot, live] });
    const result = await link(harness);
    expect(result).toMatchObject({ success: true, worktreeId: 'WT-1' });

    const prunable = buildHarness({
      worktrees: [stale, live],
      liveWorktrees: [{ path: ROOT, branch: BRANCH }, { path: stalePath, branch: BRANCH, prunable: true }],
    });
    expect((await link(prunable)).success).toBe(true);

    const notLive = buildHarness({ worktrees: [live], liveWorktrees: [{ path: stalePath, branch: BRANCH }] });
    const notLiveResult = await link(notLive);
    expect(notLiveResult.success).toBe(false);
    expect(notLive.calls().upserts).toBe(0);

    const unreadable = buildHarness({ inventoryFailure: true });
    const unreadableResult = await link(unreadable);
    expect(unreadableResult.success).toBe(false);
    expect(unreadable.calls().upserts).toBe(0);
  }, 10_000);

  test('refuses a cross-repository PR head', async () => {
    const harness = buildHarness({ headRepository: 'someone/fork', crossRepository: true });

    const result = await link(harness);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/repository|cross/i);
    expect(harness.calls().upserts).toBe(0);
  });

  test('accepts same-repository GitHub output with an empty nested repository owner', async () => {
    const harness = buildHarness({ headRepository: '', crossRepository: false });

    const result = await link(harness);

    expect(result.success).toBe(true);
    expect(harness.calls().upserts).toBe(1);
  });

  test('fails when the exact open binding cannot be read back after the write', async () => {
    const harness = buildHarness({ readBackFailure: true });

    const result = await link(harness);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/read.back|verify/i);
    expect(harness.calls().upserts).toBe(1);
  });

  test('requires the full issue UUID and exact 40-character head', async () => {
    const harness = buildHarness();

    expect((await link(harness, ['link', '42', '--issue', '619e1cd4', '--expect-head', HEAD])).success)
      .toBe(false);
    expect((await link(harness, ['link', '42', '--issue', ISSUE, '--expect-head', 'abc'])).success)
      .toBe(false);
    expect(harness.calls().upserts).toBe(0);
  });
});
