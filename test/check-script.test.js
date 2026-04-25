const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

describe('scripts/validate.js', () => {
  const checkScriptPath = path.join(__dirname, '..', 'scripts', 'validate.js');

  describe('Script existence and entrypoint wiring', () => {
    test('should exist', () => {
      expect(fs.existsSync(checkScriptPath)).toBeTruthy();
    });

    test('should have a node shebang for CLI execution', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      const firstLine = content.split('\n')[0];
      expect(firstLine.includes('#!/usr/bin/env node')).toBeTruthy();
    });

    test('should export main and guard direct execution', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      expect(content).toContain('if (require.main === module)');
      expect(content).toContain('module.exports');
    });
  });

  describe('Check orchestration', () => {
    test('should run checks in correct order', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');

      const typecheckIndex = content.indexOf('Type Check');
      const lintIndex = content.indexOf('Lint');
      const testIndex = content.indexOf('Tests');

      expect(typecheckIndex > 0).toBeTruthy();
      expect(lintIndex > typecheckIndex).toBeTruthy();
      expect(testIndex > lintIndex).toBeTruthy();
    });

    test('should run security check', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      expect(content.includes('audit') || content.includes('security')).toBeTruthy();
    });

    test('should stop on first failure', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      expect(content.includes('return 1') || content.includes('throw')).toBeTruthy();
    });
  });

  describe('Output formatting', () => {
    test('should provide clear progress helpers', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      expect(content).toContain('printHeader');
      expect(content).toContain('printStatus');
    });

    test('should use colors for better readability', () => {
      const content = fs.readFileSync(checkScriptPath, 'utf-8');
      const hasColors = content.includes('\\u001b[') || content.includes('process.stdout.isTTY');
      expect(hasColors).toBeTruthy();
    });
  });

  describe('Integration with package.json', () => {
    test('package.json should have check script', () => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
      );

      expect(packageJson.scripts.check).toBeTruthy();
      expect(packageJson.scripts.check.includes('scripts/validate.js')).toBeTruthy();
    });
  });
});
