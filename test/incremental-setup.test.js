const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
const setupPath = path.join(__dirname, '..', 'lib', 'commands', 'setup.js');

describe('Incremental setup with content-hash, agent detection, and --force flag', () => {
  // Read forge.js and setup.js source for structural tests
  const forgeSource = fs.readFileSync(forgePath, 'utf-8');
  // Setup functions were extracted from bin/forge.js to lib/commands/setup.js
  const setupSource = fs.readFileSync(setupPath, 'utf-8');

  describe('--force flag parsing', () => {
    test('parseFlags initializes force: false in the flags object', () => {
      expect(forgeSource).toContain('force: false');
    });

    test('--force flag is recognized in parseFlags', () => {
      expect(forgeSource).toContain("'--force'");
    });

    test('--force sets flags.force to true', () => {
      expect(forgeSource).toContain('flags.force = true');
    });
  });

  describe('agent auto-detection wiring', () => {
    test('detect-agent module is required', () => {
      expect(setupSource).toContain("require('../detect-agent')");
    });

    test('detectEnvironment is destructured from the require', () => {
      expect(setupSource).toMatch(/detectEnvironment\b.*require/);
    });

    test('detectEnvironment is called during setup flow', () => {
      expect(setupSource).toContain('detectEnvironment(');
    });
  });

  describe('content-hash wiring', () => {
    test('file-hash module is required', () => {
      expect(setupSource).toContain("require('../file-hash')");
    });

    test('fileMatchesContent is destructured from the require', () => {
      expect(setupSource).toMatch(/fileMatchesContent\b.*require/);
    });

    test('fileMatchesContent is called in copyFile', () => {
      const copyFileStart = setupSource.indexOf('function copyFile(');
      const copyFileEnd = setupSource.indexOf('\nfunction ', copyFileStart + 1);
      const copyFileBody = setupSource.slice(copyFileStart, copyFileEnd > copyFileStart ? copyFileEnd : undefined);
      expect(copyFileBody).toContain('fileMatchesContent');
    });
  });

  describe('action log wiring', () => {
    test('setup-action-log module is required', () => {
      expect(setupSource).toContain("require('../setup-action-log')");
    });

    test('SetupActionLog is destructured from the require', () => {
      expect(setupSource).toMatch(/SetupActionLog\b.*require/);
    });

    test('actionLog instance is created in a setup function', () => {
      expect(setupSource).toContain('new SetupActionLog()');
    });

    test('actionLog.add is called to record file operations', () => {
      expect(setupSource).toContain('actionLog.add(');
    });
  });

  describe('copyFile returns skip status for identical files', () => {
    test('copyFile function handles skipped status', () => {
      const copyFileStart = setupSource.indexOf('function copyFile(');
      const copyFileEnd = setupSource.indexOf('\nfunction ', copyFileStart + 1);
      const copyFileBody = setupSource.slice(copyFileStart, copyFileEnd > copyFileStart ? copyFileEnd : undefined);
      expect(copyFileBody).toContain('skipped');
    });

    test('copyFile respects force mode', () => {
      const copyFileStart = setupSource.indexOf('function copyFile(');
      const copyFileEnd = setupSource.indexOf('\nfunction ', copyFileStart + 1);
      const copyFileBody = setupSource.slice(copyFileStart, copyFileEnd > copyFileStart ? copyFileEnd : undefined);
      expect(
        copyFileBody.includes('FORCE_MODE') || copyFileBody.includes('forceMode')
      ).toBe(true);
    });
  });

  describe('lib module unit tests', () => {
    test('fileMatchesContent returns true for identical content', () => {
      const { fileMatchesContent } = require('../lib/file-hash');
      const os = require('node:os');
      const tmpFile = path.join(os.tmpdir(), `forge-test-hash-${Date.now()}.txt`);
      const content = 'hello world test content';
      fs.writeFileSync(tmpFile, content);
      try {
        expect(fileMatchesContent(tmpFile, content)).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test('fileMatchesContent returns false for different content', () => {
      const { fileMatchesContent } = require('../lib/file-hash');
      const os = require('node:os');
      const tmpFile = path.join(os.tmpdir(), `forge-test-hash-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, 'original content');
      try {
        expect(fileMatchesContent(tmpFile, 'different content')).toBe(false);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test('fileMatchesContent returns false for nonexistent file', () => {
      const { fileMatchesContent } = require('../lib/file-hash');
      expect(fileMatchesContent('/nonexistent/path/file.txt', 'content')).toBe(false);
    });

    test('SetupActionLog tracks actions and provides summary', () => {
      const { SetupActionLog } = require('../lib/setup-action-log');
      const log = new SetupActionLog();
      log.add('AGENTS.md', 'created', 'universal standard');
      log.add('.claude/settings.json', 'skipped', 'identical content');
      log.add('lefthook.yml', 'created', null);

      expect(log.length).toBe(3);
      const summary = log.getSummary();
      expect(summary.created).toBe(2);
      expect(summary.skipped).toBe(1);
    });

    test('detectEnvironment returns expected structure', () => {
      const { detectEnvironment } = require('../lib/detect-agent');
      const os = require('node:os');
      const result = detectEnvironment(os.tmpdir(), {});
      expect(result).toHaveProperty('activeAgent');
      expect(result).toHaveProperty('configuredAgents');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('editor');
      expect(result.activeAgent).toBeNull();
      expect(Array.isArray(result.configuredAgents)).toBe(true);
    });
  });
});
