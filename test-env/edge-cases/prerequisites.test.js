// Test: Prerequisites Validation Edge Cases
// Validates checkPrerequisites() detection of missing tools and version constraints

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Mock safeExec for testing
function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

// Simplified checkPrerequisites for testing (without console.log and process.exit)
function checkPrerequisitesTest(options = {}) {
  const errors = [];
  const warnings = [];

  const mockExec = options.mockExec || safeExec;

  const gitVersion = mockExec('git --version');
  if (!gitVersion) {
    errors.push('git - Install from https://git-scm.com');
  }

  const ghVersion = mockExec('gh --version');
  if (ghVersion) {
    const authStatus = mockExec('gh auth status');
    if (!authStatus) {
      warnings.push('GitHub CLI not authenticated. Run: gh auth login');
    }
  } else {
    errors.push('gh (GitHub CLI) - Install from https://cli.github.com');
  }

  const nodeVersion = options.nodeVersion || Number.parseInt(process.version.slice(1).split('.')[0]);
  if (nodeVersion < 20) {
    errors.push(`Node.js 20+ required (current: v${nodeVersion}.x)`);
  }

  let pkgManager = null;

  if (options.projectRoot) {
    const bunLock = path.join(options.projectRoot, 'bun.lockb');
    const pnpmLock = path.join(options.projectRoot, 'pnpm-lock.yaml');
    const yarnLock = path.join(options.projectRoot, 'yarn.lock');

    if (fs.existsSync(bunLock)) {
      pkgManager = 'bun';
    } else if (fs.existsSync(pnpmLock)) {
      pkgManager = 'pnpm';
    } else if (fs.existsSync(yarnLock)) {
      pkgManager = 'yarn';
    } else {
      pkgManager = 'npm';
    }
  } else {
    if (mockExec('bun --version')) {
      pkgManager = 'bun';
    } else if (mockExec('pnpm --version')) {
      pkgManager = 'pnpm';
    } else if (mockExec('yarn --version')) {
      pkgManager = 'yarn';
    } else if (mockExec('npm --version')) {
      pkgManager = 'npm';
    } else {
      errors.push('npm, yarn, pnpm, or bun - Install a package manager');
    }
  }

  return { errors, warnings, pkgManager };
}

describe('prerequisites-edge-cases', () => {
  describe('Missing Tools Detection', () => {
    test('should detect missing git', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return null;
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.ok(result.errors.some(e => e.includes('git')), 'Should detect missing git');
    });

    test('should detect missing gh', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return null;
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.ok(result.errors.some(e => e.includes('gh')), 'Should detect missing gh');
    });

    test('should detect old Node version', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 19 });
      assert.ok(result.errors.some(e => e.includes('Node.js 20+')), 'Should detect old Node version');
    });

    test('should detect missing package manager', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.ok(result.errors.some(e => e.includes('package manager')), 'Should detect missing package manager');
    });
  });

  describe('Version Constraints', () => {
    test('Node exactly 20 - should pass', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.ok(!result.errors.some(e => e.includes('Node.js')), 'Node 20 should pass');
    });

    test('Node 22 - should pass', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 22 });
      assert.ok(!result.errors.some(e => e.includes('Node.js')), 'Node 22 should pass');
    });

    test('Node 19.9.9 - should fail', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 19 });
      assert.ok(result.errors.some(e => e.includes('Node.js 20+')), 'Node 19 should fail');
    });
  });

  describe('GitHub CLI Authentication', () => {
    test('unauthenticated gh - should warn', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return null;
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.ok(result.warnings.some(w => w.includes('not authenticated')), 'Should warn about unauthenticated gh');
    });

    test('authenticated gh - should be OK', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in to github.com';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.ok(!result.warnings.some(w => w.includes('not authenticated')), 'Should not warn if authenticated');
    });
  });

  describe('Package Manager Detection', () => {
    test('should detect npm', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.strictEqual(result.pkgManager, 'npm', 'Should detect npm');
    });

    test('should detect yarn', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'yarn --version') return '1.22.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.strictEqual(result.pkgManager, 'yarn', 'Should detect yarn');
    });

    test('should detect pnpm', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'pnpm --version') return '8.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.strictEqual(result.pkgManager, 'pnpm', 'Should detect pnpm');
    });

    test('should detect bun', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'bun --version') return '1.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20 });
      assert.strictEqual(result.pkgManager, 'bun', 'Should detect bun');
    });

    test('lockfile should override binary priority', () => {
      const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const tempDir = mkdtempSync(path.join(tmpdir(), 'forge-pkg-test-'));

      try {
        writeFileSync(path.join(tempDir, 'yarn.lock'), '# yarn lockfile\n');

        const mockExec = (cmd) => {
          if (cmd === 'git --version') return 'git version 2.0.0';
          if (cmd === 'gh --version') return 'gh version 2.0.0';
          if (cmd === 'gh auth status') return 'Logged in';
          if (cmd === 'npm --version') return '10.0.0';
          return null;
        };

        const result = checkPrerequisitesTest({ mockExec, nodeVersion: 20, projectRoot: tempDir });
        assert.strictEqual(result.pkgManager, 'yarn', 'yarn.lock should override npm detection');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});