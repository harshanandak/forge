const { describe, expect, test } = require('bun:test');
const setupCommand = require('../lib/commands/setup');

describe('setup gh prerequisites', () => {
  test('checkPrerequisites requires gh when setup is preparing workflow-capable installs', () => {
    const originalExit = process.exit;
    const originalLog = console.log;
    const logLines = [];

    process.exit = (code) => {
      throw new Error(`process.exit:${code}`);
    };
    console.log = (...parts) => logLines.push(parts.join(' '));

    try {
      expect(() => setupCommand.checkPrerequisites({
        requireGithubCli: true,
        commandRunner: (command) => {
          if (command === 'git --version') {
            return 'git version 2.42.0';
          }
          return '';
        },
      })).toThrow(/process\.exit:1/);
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }

    expect(logLines.join('\n')).toContain('gh (GitHub CLI) - Install from https://cli.github.com');
  });
});

describe('setup runtime prerequisite', () => {
  function runCheck(runtimeVersions) {
    const originalExit = process.exit;
    const originalLog = console.log;
    const logLines = [];
    process.exit = (code) => {
      throw new Error(`process.exit:${code}`);
    };
    console.log = (...parts) => logLines.push(parts.join(' '));
    try {
      setupCommand.checkPrerequisites({
        requireGithubCli: false,
        runtimeVersions,
        commandRunner: () => '',
      });
    } catch (error) {
      logLines.push(String(error.message));
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }
    return logLines.join('\n');
  }

  test('Bun reporting an emulated Node 22 is not refused', () => {
    const output = runCheck({ node: '22.6.0', bun: '1.2.14' });
    expect(output).not.toContain('Node.js 24+ required');
    expect(output).toContain('✓ bun v1.2.14');
  });

  test('real Node 22 is refused with an upgrade message', () => {
    const output = runCheck({ node: '22.16.0' });
    expect(output).toContain('Node.js 24+ required (current: v22.16.0)');
  });
});
