const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('scripts/check.sh', () => {
  const checkScriptPath = path.join(__dirname, '..', 'scripts', 'check.sh');

  describe('Script existence and permissions', () => {
    test('should exist', () => {
      assert.ok(fs.existsSync(checkScriptPath), 'check.sh should exist');
    });

    test('should be executable', () => {
      // On Windows, we check if file exists (executable bit not applicable)
      // On Unix, we check if executable bit is set
      if (process.platform === 'win32') {
        assert.ok(fs.existsSync(checkScriptPath), 'check.sh should exist on Windows');
      } else {
        const stats = fs.statSync(checkScriptPath);
        const isExecutable = (stats.mode & 0o111) !== 0;
        assert.ok(isExecutable, 'check.sh should be executable on Unix');
      }
    });

    test('should have proper shebang for cross-platform compatibility', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      const firstLine = content.split('\n')[0];
      // Should use #!/usr/bin/env bash or #!/bin/sh for portability
      assert.ok(
        firstLine.includes('#!/usr/bin/env bash') || firstLine.includes('#!/bin/sh'),
        'Should have portable shebang'
      );
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

      assert.ok(typecheckIndex > 0, 'Should include type check');
      assert.ok(lintIndex > typecheckIndex, 'Lint should come after typecheck');
      assert.ok(testIndex > lintIndex, 'Tests should come after lint');
    });

    test('should run security check', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should include security scan (npm audit or similar)
      assert.ok(
        content.includes('audit') || content.includes('security'),
        'Should include security check'
      );
    });

    test('should stop on first failure', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should use 'set -e' to exit on first error
      // OR explicitly check exit codes
      assert.ok(
        content.includes('set -e') || content.includes('exit 1') || content.includes('$?'),
        'Should handle failures properly'
      );
    });
  });

  describe('Output formatting', () => {
    test('should provide clear progress indicators', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should have echo statements showing progress
      const echoCount = (content.match(/echo/g) || []).length;
      assert.ok(echoCount >= 4, 'Should have progress messages for each check');
    });

    test('should use colors for better readability', function() {
      // Skip color checks on CI environments that don't support it
      if (process.env.CI) {
        this.skip();
        return;
      }

      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      // Should include ANSI color codes or tput commands
      const hasColors = content.includes('\033[') || content.includes('tput');
      assert.ok(hasColors, 'Should use colors for output');
    });
  });

  describe('Integration with package.json', () => {
    test('package.json should have check script', () => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
      );

      assert.ok(packageJson.scripts.check, 'package.json should have check script');
      assert.ok(
        packageJson.scripts.check.includes('scripts/check.sh'),
        'check script should reference scripts/check.sh'
      );
    });
  });
});
