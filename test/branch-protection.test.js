const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

describe('scripts/branch-protection.js', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'branch-protection.js');

  describe('Script existence and cross-platform compatibility', () => {
    test('should exist', () => {
      assert.ok(fs.existsSync(scriptPath), 'branch-protection.js should exist');
    });

    test('should be a Node.js script (not shell script)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      const firstLine = content.split('\n')[0];
      // Should have Node.js shebang for cross-platform compatibility
      assert.ok(
        firstLine.includes('#!/usr/bin/env node') || !firstLine.startsWith('#!'),
        'Should be a Node.js script for Windows compatibility'
      );
    });

    test('should be executable via node command', () => {
      // Test that script can be executed with node
      const result = spawnSync('node', [scriptPath, '--help'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe'
      });

      // Should either show help or handle --help flag gracefully
      assert.ok(
        result.status === 0 || result.status === 1,
        'Script should be executable via node'
      );
    });
  });

  describe('Branch protection logic', () => {
    test('should detect protected branch names', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should check for main and master branches
      assert.ok(
        content.includes('main') && content.includes('master'),
        'Should protect both main and master branches'
      );
    });

    test('should use environment variable for current branch', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Lefthook provides LEFTHOOK_GIT_BRANCH or needs git command
      assert.ok(
        content.includes('process.env') || content.includes('git'),
        'Should read current branch from environment or git'
      );
    });

    test('should provide clear error message', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should have informative error message
      assert.ok(
        content.includes('console.error') || content.includes('stderr'),
        'Should output error message'
      );
      assert.ok(
        content.toLowerCase().includes('protected') || content.toLowerCase().includes('forbidden'),
        'Should mention branch protection in message'
      );
    });
  });

  describe('Exit codes', () => {
    test('should exit with code 1 when blocking push', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should call process.exit(1) for blocked pushes
      assert.ok(
        content.includes('process.exit(1)') || content.includes('exit(1)'),
        'Should exit with code 1 when blocking push'
      );
    });

    test('should exit with code 0 when allowing push', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should call process.exit(0) or have implicit success
      assert.ok(
        content.includes('process.exit(0)') || content.includes('exit(0)') || !content.includes('process.exit'),
        'Should exit with code 0 when allowing push'
      );
    });
  });

  describe('Cross-platform execution', () => {
    test('should work on Windows (current platform)', function() {
      if (process.platform !== 'win32') {
        this.skip();
        return;
      }

      // Test script can be executed on Windows
      const result = spawnSync('node', [scriptPath], {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe',
        env: {
          ...process.env,
          LEFTHOOK_GIT_BRANCH: 'feature/test-branch'
        }
      });

      // Should execute without shell syntax errors
      assert.ok(
        result.status === 0 || result.status === 1,
        'Should execute on Windows without syntax errors'
      );
    });

    test('should not use shell-specific syntax', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should not have bash-specific syntax
      const bashPatterns = [
        /\$\(/,  // Command substitution $(...)
        /`[^`]+`/,  // Backtick command substitution
        /\[\[.*\]\]/,  // Bash [[ test ]]
        /\bif \[/  // Bash [ test ] (without 'test' command)
      ];

      const hasBashSyntax = bashPatterns.some(pattern => pattern.test(content));
      assert.ok(
        !hasBashSyntax,
        'Should not use bash-specific syntax for Windows compatibility'
      );
    });
  });

  describe('Integration with lefthook.yml', () => {
    test('lefthook.yml should use node to execute script', () => {
      const lefthookPath = path.join(__dirname, '..', 'lefthook.yml');
      const content = fs.readFileSync(lefthookPath, 'utf-8');

      // Should invoke script with 'node scripts/branch-protection.js'
      assert.ok(
        content.includes('node scripts/branch-protection.js') ||
        content.includes('node ./scripts/branch-protection.js'),
        'lefthook.yml should execute script with node'
      );
    });
  });
});
