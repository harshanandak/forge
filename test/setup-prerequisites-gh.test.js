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
