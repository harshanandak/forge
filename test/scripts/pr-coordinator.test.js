const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, expect, test, setDefaultTimeout } = require('bun:test');

setDefaultTimeout(15000);

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'pr-coordinator.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function resolveBashCommand() {
  if (process.env.BASH_CMD) {
    return process.env.BASH_CMD;
  }

  if (process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)) {
    return GIT_BASH_PATH;
  }

  return 'bash';
}

function runCoordinator(args = [], env = {}, cwd = PROJECT_ROOT) {
  const result = spawnSync(resolveBashCommand(), [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ...env,
    },
  });

  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pr-coordinator-'));
}

// Sanitized env: strip git hook variables so temp-repo git commands
// never accidentally operate on the real worktree during pre-push hooks.
const _cleanEnv = (() => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_QUARANTINE_PATH;
  return env;
})();

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: _cleanEnv,
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

describe('scripts/pr-coordinator.sh', () => {
  test('stale-worktrees reads git porcelain and does not require a .worktrees directory', () => {
    const repoRoot = makeTempRepo();
    const worktreePath = path.join(repoRoot, 'parallel', 'feature-a');

    try {
      git(repoRoot, ['init']);
      git(repoRoot, ['config', 'user.email', 'test@example.com']);
      git(repoRoot, ['config', 'user.name', 'Forge Test']);
      fs.writeFileSync(path.join(repoRoot, 'README.md'), 'base\n');
      git(repoRoot, ['add', 'README.md']);
      git(repoRoot, ['commit', '-m', 'base']);
      git(repoRoot, ['worktree', 'add', worktreePath, '-b', 'feat/feature-a']);

      expect(fs.existsSync(path.join(repoRoot, '.worktrees'))).toBe(false);

      const result = runCoordinator(['stale-worktrees', '--threshold=0h'], {}, repoRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('STALE: feature-a');
      expect(result.stdout).not.toContain('.worktrees');
      expect(result.stdout).toContain('1 potentially abandoned worktree(s) found');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
