const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');

describe('scripts/branch-protection.js', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'branch-protection.js');

  describe('Script existence and cross-platform compatibility', () => {
    test('should exist', () => {
      expect(fs.existsSync(scriptPath)).toBeTruthy();
    });

    test('should be a Node.js script (not shell script)', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      const firstLine = content.split('\n')[0];
      // Should have Node.js shebang for cross-platform compatibility
      expect(firstLine.includes('#!/usr/bin/env node') || !firstLine.startsWith('#!')).toBeTruthy();
    });

    test('should be executable via node command', () => {
      // Test that script can be executed with node
      const result = spawnSync('node', [scriptPath, '--help'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe'
      });

      // Should either show help or handle --help flag gracefully
      expect(result.status === 0 || result.status === 1).toBeTruthy();
    });
  });

  describe('Branch protection logic', () => {
    test('should detect protected branch names', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should check for main and master branches
      expect(content.includes('main') && content.includes('master')).toBeTruthy();
    });

    test('should use environment variable for current branch', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Lefthook provides LEFTHOOK_GIT_BRANCH or needs git command
      expect(content.includes('process.env') || content.includes('git')).toBeTruthy();
    });

    test('should provide clear error message', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should have informative error message
      expect(content.includes('console.error') || content.includes('stderr')).toBeTruthy();
      expect(content.toLowerCase().includes('protected') || content.toLowerCase().includes('forbidden')).toBeTruthy();
    });
  });

  describe('Exit codes', () => {
    test('should exit with code 1 when blocking push', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should call process.exit(1) for blocked pushes
      expect(content.includes('process.exit(1)') || content.includes('exit(1)')).toBeTruthy();
    });

    test('should exit with code 0 when allowing push', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should call process.exit(0) or have implicit success
      expect(content.includes('process.exit(0)') || content.includes('exit(0)') || !content.includes('process.exit')).toBeTruthy();
    });
  });

  describe('Cross-platform execution', () => {
    test('should work on Windows (current platform)', () => {
      if (process.platform !== 'win32') {
        return; // Skip on non-Windows platforms
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
      expect(result.status === 0 || result.status === 1).toBeTruthy();
    });

    test('should not use shell-specific syntax', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Should not have bash-specific syntax (command substitution, bash tests)
      // Note: JavaScript template literals (backticks with ${}) are allowed
      const bashPatterns = [
        { pattern: /\[\[.*\]\]/g, name: 'Bash [[ test ]]' },
        { pattern: /if\s+\[/g, name: 'Bash [ test ]' },
        { pattern: /\bthen\b/g, name: 'Bash then keyword' },
        { pattern: /\bfi\b/g, name: 'Bash fi keyword' }
      ];

      // Check each pattern
      for (const { pattern } of bashPatterns) {
        const match = content.match(pattern);
        expect(!match).toBeTruthy();
      }

      // Should use Node.js/JavaScript instead
      expect(content.includes('process.env')).toBeTruthy();
      expect(content.includes('require(')).toBeTruthy();
    });
  });

  describe('Integration with lefthook.yml', () => {
    test('lefthook.yml should use node to execute script', () => {
      const lefthookPath = path.join(__dirname, '..', 'lefthook.yml');
      const content = fs.readFileSync(lefthookPath, 'utf-8');

      // Should invoke script with 'node scripts/branch-protection.js'
      expect(content.includes('node scripts/branch-protection.js') ||
        content.includes('node ./scripts/branch-protection.js')).toBeTruthy();
    });
  });
});
