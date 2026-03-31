const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');

describe('scripts/branch-protection.js — safe require() guard', () => {
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'branch-protection.js');

  test('require() should NOT trigger main() execution', () => {
    // Run a child process that requires the module and checks for side effects.
    // If the module runs main() on require, the child process will call process.exit()
    // inside getCurrentBranch() (no git available) and never reach the sentinel print.
    const wrapper = `
      process.env.LEFTHOOK_GIT_BRANCH = 'feat/test';
      process.env.NODE_ENV = 'test';
      const mod = require(${JSON.stringify(scriptPath)});
      // If we get here, main() did NOT run (no process.exit called)
      process.stdout.write('IMPORT_OK\\n');
    `;
    const result = spawnSync(process.execPath, ['-e', wrapper], {
      stdio: 'pipe',
      timeout: 5000,
    });
    const stdout = result.stdout.toString();
    expect(stdout).toContain('IMPORT_OK');
  });

  test('require() should export a callable function', () => {
    const wrapper = `
      process.env.LEFTHOOK_GIT_BRANCH = 'feat/test';
      process.env.NODE_ENV = 'test';
      const mod = require(${JSON.stringify(scriptPath)});
      const fnName = typeof mod.checkBranchProtection === 'function'
        ? 'checkBranchProtection'
        : typeof mod.runBranchProtection === 'function'
          ? 'runBranchProtection'
          : typeof mod.main === 'function'
            ? 'main'
            : null;
      if (fnName) {
        process.stdout.write('EXPORT_OK:' + fnName + '\\n');
      } else {
        process.stdout.write('NO_EXPORT\\n');
      }
    `;
    const result = spawnSync(process.execPath, ['-e', wrapper], {
      stdio: 'pipe',
      timeout: 5000,
    });
    const stdout = result.stdout.toString();
    expect(stdout).toContain('EXPORT_OK');
  });

  test('exported function should return an exit code (number) instead of calling process.exit()', () => {
    // We need a mock git so the function can actually run without real git.
    // Create an inline mock-git.js that always returns a feature branch.
    const wrapper = `
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');

      // Create a temp mock-git.js
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-'));
      const mockGitJs = path.join(tmpDir, 'mock-git.js');
      fs.writeFileSync(mockGitJs, \`
        const args = process.argv.slice(2).join(' ');
        if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
          process.stdout.write('feat/safe-branch\\\\n');
          process.exit(0);
        }
        process.stdout.write('feat/safe-branch\\\\n');
        process.exit(0);
      \`);

      process.env.NODE_ENV = 'test';
      process.env.FORGE_GIT_MOCK_JS = mockGitJs;
      process.env.LEFTHOOK_GIT_BRANCH = 'feat/safe-branch';

      const mod = require(${JSON.stringify(scriptPath)});
      const fn = mod.checkBranchProtection || mod.runBranchProtection || mod.main;
      if (!fn) {
        process.stdout.write('NO_FUNCTION\\n');
        process.exit(1);
      }
      const code = fn();
      if (typeof code === 'number') {
        process.stdout.write('RETURNED_CODE:' + code + '\\n');
      } else {
        process.stdout.write('NOT_A_NUMBER:' + typeof code + '\\n');
      }

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    `;
    const result = spawnSync(process.execPath, ['-e', wrapper], {
      stdio: 'pipe',
      timeout: 5000,
    });
    const stdout = result.stdout.toString();
    expect(stdout).toContain('RETURNED_CODE:0');
  });

  test('direct execution via node still works (exits with code 0 for feature branch)', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      stdio: 'pipe',
      timeout: 5000,
      env: {
        ...process.env,
        LEFTHOOK_GIT_BRANCH: 'feat/direct-exec-test',
      },
    });
    expect(result.status).toBe(0);
  });

  test('direct execution via node still blocks protected branches', () => {
    const fs = require('node:fs');
    const os = require('node:os');

    // Create mock git for master branch with non-beads files
    const tmpDir = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bp-block-'));
    const mockGitJs = path.join(tmpDir, 'mock-git.js');
    fs.writeFileSync(mockGitJs, `
      const args = process.argv.slice(2).join(' ');
      if (args.includes('rev-parse') && args.includes('@{u}')) {
        process.stdout.write('origin/master\\n');
        process.exit(0);
      }
      if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
        process.stdout.write('master\\n');
        process.exit(0);
      }
      if (args.includes('diff') && args.includes('--name-only')) {
        process.stdout.write('src/index.js\\n');
        process.exit(0);
      }
      process.stdout.write('master\\n');
      process.exit(0);
    `);

    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        stdio: 'pipe',
        timeout: 5000,
        env: {
          ...process.env,
          LEFTHOOK_GIT_BRANCH: 'master',
          FORGE_GIT_MOCK_JS: mockGitJs,
          NODE_ENV: 'test',
        },
      });
      expect(result.status).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
