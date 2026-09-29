// Test: Prerequisites Validation Edge Cases
// Validates checkPrerequisites() detection of missing tools and version constraints

import { describe, test, expect } from 'bun:test';
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { MIN_NODE_MAJOR, nodeVersionError } = require('../../lib/node-requirement');

// Mock safeExec for testing
function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (_e) {
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

  const nodeError = nodeVersionError(options.nodeVersion || process.version);
  if (nodeError) {
    errors.push(nodeError);
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

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.errors.some(e => e.includes('git'))).toBeTruthy();
    });

    test('should detect missing gh', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return null;
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.errors.some(e => e.includes('gh'))).toBeTruthy();
    });

    test('should detect old Node version', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 22 });
      expect(result.errors.some(e => e.includes('Node.js 24+'))).toBeTruthy();
    });

    test('should detect missing package manager', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.errors.some(e => e.includes('package manager'))).toBeTruthy();
    });
  });

  describe('Version Constraints', () => {
    test('minimum matches package.json engines.node', () => {
      const pkg = require('../../package.json');
      expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}.0.0`);
      expect(MIN_NODE_MAJOR).toBe(24);
    });

    test('Node 24 - should pass', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(!result.errors.some(e => e.includes('Node.js'))).toBeTruthy();
    });

    test('Node 26 - should pass', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 26 });
      expect(!result.errors.some(e => e.includes('Node.js'))).toBeTruthy();
    });

    test('Node 22 - should fail with a clear upgrade message', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 22 });
      const nodeErrors = result.errors.filter(e => e.includes('Node.js'));
      expect(nodeErrors).toHaveLength(1);
      expect(nodeErrors[0]).toContain('Node.js 24+ required');
      expect(nodeErrors[0]).toContain('current: v22.x');
      expect(nodeErrors[0]).toContain('Upgrade Node.js');
    });

    test('full version strings: v22.16.0 fails, v24.0.0 and v26.1.0 pass', () => {
      expect(nodeVersionError('v22.16.0')).toContain('Node.js 24+ required (current: v22.16.0)');
      expect(nodeVersionError('v24.0.0')).toBeNull();
      expect(nodeVersionError('v26.1.0')).toBeNull();
      expect(nodeVersionError('garbage')).toContain('Node.js 24+ required');
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

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.warnings.some(w => w.includes('not authenticated'))).toBeTruthy();
    });

    test('authenticated gh - should be OK', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in to github.com';
        if (cmd === 'npm --version') return '10.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(!result.warnings.some(w => w.includes('not authenticated'))).toBeTruthy();
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

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.pkgManager).toBe('npm');
    });

    test('should detect yarn', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'yarn --version') return '1.22.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.pkgManager).toBe('yarn');
    });

    test('should detect pnpm', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'pnpm --version') return '8.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.pkgManager).toBe('pnpm');
    });

    test('should detect bun', () => {
      const mockExec = (cmd) => {
        if (cmd === 'git --version') return 'git version 2.0.0';
        if (cmd === 'gh --version') return 'gh version 2.0.0';
        if (cmd === 'gh auth status') return 'Logged in';
        if (cmd === 'bun --version') return '1.0.0';
        return null;
      };

      const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24 });
      expect(result.pkgManager).toBe('bun');
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

        const result = checkPrerequisitesTest({ mockExec, nodeVersion: 24, projectRoot: tempDir });
        expect(result.pkgManager).toBe('yarn');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
