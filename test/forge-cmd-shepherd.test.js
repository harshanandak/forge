'use strict';

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { isValidCommand, getHelpText } = require('../bin/forge-cmd.js');

const CLI = path.join(__dirname, '..', 'bin', 'forge-cmd.js');

describe('forge-cmd shepherd dispatch', () => {
  test('shepherd is a valid command', () => {
    expect(isValidCommand('shepherd')).toBe(true);
  });

  test('help text lists shepherd with a description', () => {
    const help = getHelpText();
    expect(help).toContain('shepherd');
  });

  test('existing commands remain valid (no regression)', () => {
    for (const cmd of ['status', 'plan', 'dev', 'validate', 'ship', 'review', 'merge', 'verify']) {
      expect(isValidCommand(cmd)).toBe(true);
    }
  });

  test('unknown command path is unchanged', () => {
    expect(isValidCommand('definitely-not-a-command')).toBe(false);
  });

  test('forge shepherd with no PR argument reports usage and exits non-zero', () => {
    const res = spawnSync('node', [CLI, 'shepherd'], { encoding: 'utf8', timeout: 20000 });
    const combined = `${res.stdout || ''}${res.stderr || ''}`;
    expect(combined.toLowerCase()).toContain('shepherd');
    expect(res.status).not.toBe(0);
  });
});
