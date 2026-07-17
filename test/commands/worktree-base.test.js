'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// B2 (5f7e3f9b): `forge worktree create` must fork a NEW branch off the repo's
// DEFAULT branch, not the checkout's current HEAD. Uses REAL git repos so the
// fork point is genuinely verified (merge-base / log), plus --base override and
// invalid-base handling.
// ---------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Stub the kernel so no real SQLite driver is opened (Windows EBUSY on cleanup);
// the real git worktree creation is what these tests exercise.
const stubOpts = () => ({
  _kernelDriver: { registerWorktree: () => {}, listWorktrees: () => [] },
  _kernelBroker: {},
  _ensureBackingIssue: async () => null,
});

// `git worktree add` runs in process.cwd(); production always invokes the handler
// with projectRoot === cwd. Replicate that invariant so the real git commands
// target the temp repo, then restore.
async function createIn(root, args) {
  const mod = require('../../lib/commands/worktree');
  const prev = process.cwd();
  process.chdir(root);
  try {
    return await mod.handler(args, {}, root, stubOpts());
  } finally {
    process.chdir(prev);
  }
}

const roots = [];

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wt-base-'));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base commit');
  return root;
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* best-effort temp cleanup */ }
  }
});

describe('forge worktree create — base ref (B2)', () => {
  test('bases the new branch off the default branch, NOT the current checked-out branch', async () => {
    const root = initRepo();
    const defaultHead = git(root, 'rev-parse', 'HEAD').trim();

    // Switch to a WIP branch with a commit absent from the default branch.
    git(root, 'checkout', '-b', 'feat/wip');
    fs.writeFileSync(path.join(root, 'wip.txt'), 'wip\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'wip-only commit');
    const wipHead = git(root, 'rev-parse', 'HEAD').trim();

    const result = await createIn(root, ['create', 'myslug']);

    expect(result.success).toBe(true);
    // No remote → local default branch is the base.
    expect(result.base).toBe('main');
    // The new branch forked from the default HEAD, not the WIP HEAD.
    const newHead = git(root, 'rev-parse', 'feat/myslug').trim();
    expect(newHead).toBe(defaultHead);
    expect(newHead).not.toBe(wipHead);
    // The WIP-only commit must NOT be in the new branch history.
    const log = git(root, 'log', '--format=%H', 'feat/myslug');
    expect(log).not.toContain(wipHead);
  });

  test('--base <ref> overrides the default base', async () => {
    const root = initRepo();
    const firstHead = git(root, 'rev-parse', 'HEAD').trim();
    // Advance the default branch past the first commit.
    fs.writeFileSync(path.join(root, 'more.txt'), 'more\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'second commit');
    const secondHead = git(root, 'rev-parse', 'HEAD').trim();

    const result = await createIn(root, ['create', 'pinned', '--base', firstHead]);

    expect(result.success).toBe(true);
    expect(result.base).toBe(firstHead);
    const newHead = git(root, 'rev-parse', 'feat/pinned').trim();
    expect(newHead).toBe(firstHead);
    expect(newHead).not.toBe(secondHead);
  });

  test('invalid --base errors clearly and creates nothing', async () => {
    const root = initRepo();

    const result = await createIn(root, ['create', 'bad', '--base', 'no-such-ref-xyz']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid --base');
    // Nothing created: no worktree dir and no branch.
    expect(fs.existsSync(path.join(root, '.worktrees', 'bad'))).toBe(false);
    expect(git(root, 'branch', '--list', 'feat/bad').trim()).toBe('');
  });

  test('the base used is reported in the output and the JSON base field', async () => {
    const root = initRepo();

    const result = await createIn(root, ['create', 'reported']);

    expect(result.success).toBe(true);
    expect(result.base).toBe('main');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('based on main');
    expect(result.output).toContain('feat/reported');
  });
});
