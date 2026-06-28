'use strict';

const { describe, test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { isValidCommand, getHelpText, validateArgs } = require('../bin/forge-cmd.js');

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

  test('validateArgs rejects an unknown shepherd flag (typo) instead of forwarding it', () => {
    const v = validateArgs('shepherd', ['123', '--auto-reabse']);
    expect(v.valid).toBe(false);
    expect(v.error).toContain('--auto-reabse');
  });

  test('validateArgs accepts the documented --auto-rebase shepherd flag', () => {
    const v = validateArgs('shepherd', ['123', '--auto-rebase']);
    expect(v.valid).toBe(true);
  });

  test('validateArgs accepts the --bundle and --json shepherd flags', () => {
    const v = validateArgs('shepherd', ['123', '--bundle', '--json']);
    expect(v.valid).toBe(true);
  });

  test('forge shepherd with an unknown flag exits non-zero before running a pass', () => {
    const res = spawnSync('node', [CLI, 'shepherd', '123', '--auto-reabse'], { encoding: 'utf8', timeout: 20000 });
    const combined = `${res.stdout || ''}${res.stderr || ''}`;
    expect(res.status).not.toBe(0);
    expect(combined).toContain('--auto-reabse');
  });
});
