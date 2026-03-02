const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('scripts/check.sh', () => {
  const checkScriptPath = path.join(__dirname, '..', 'scripts', 'check.sh');

  describe('Script existence and permissions', () => {
    test('should exist', () => {
      expect(fs.existsSync(checkScriptPath)).toBeTruthy();
    });

    test('should be executable', () => {
      // On Windows, we check if file exists (executable bit not applicable)
      // On Unix, we check if executable bit is set
      if (process.platform === 'win32') {
        expect(fs.existsSync(checkScriptPath)).toBeTruthy();
      } else {
        const stats = fs.statSync(checkScriptPath);
        const isExecutable = (stats.mode & 0o111) !== 0;
        expect(isExecutable).toBeTruthy();
      }
    });

    test('should have proper shebang for cross-platform compatibility', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      const firstLine = content.split('\n')[0];
      // Should use #!/usr/bin/env bash or #!/bin/sh for portability
      expect(firstLine.includes('#!/usr/bin/env bash') || firstLine.includes('#!/bin/sh')).toBeTruthy();
    });
  });

  // Note: Exit code testing removed to avoid recursion
  // (check.sh runs all tests including this test file)
  // Manual verification: Run `bun run check` separately

  describe('Check orchestration', () => {
    test('should run checks in correct order', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Check that commands appear in order
      const typecheckIndex = content.indexOf('typecheck');
      const lintIndex = content.indexOf('lint');
      const testIndex = content.indexOf('test');

      expect(typecheckIndex > 0).toBeTruthy();
      expect(lintIndex > typecheckIndex).toBeTruthy();
      expect(testIndex > lintIndex).toBeTruthy();
    });

    test('should run security check', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should include security scan (npm audit or similar)
      expect(content.includes('audit') || content.includes('security')).toBeTruthy();
    });

    test('should stop on first failure', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should use 'set -e' to exit on first error
      // OR explicitly check exit codes
      expect(content.includes('set -e') || content.includes('exit 1') || content.includes('$?')).toBeTruthy();
    });
  });

  describe('Output formatting', () => {
    test('should provide clear progress indicators', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should have echo statements showing progress
      const echoCount = (content.match(/echo/g) || []).length;
      expect(echoCount >= 4).toBeTruthy();
    });

    test('should use colors for better readability', () => {
      // Skip color checks on CI environments that don't support it
      if (process.env.CI) {
        return; // Skip in CI
      }

      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should include ANSI color codes or tput commands
      const hasColors = content.includes('\033[') || content.includes('tput');
      expect(hasColors).toBeTruthy();
    });
  });

  describe('Integration with package.json', () => {
    test('package.json should have check script', () => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
      );

      expect(packageJson.scripts.check).toBeTruthy();
      expect(packageJson.scripts.check.includes('scripts/check.sh')).toBeTruthy();
    });
  });
});
