const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

// Module under test
const { ActionCollector, isNonInteractive } = require('../lib/setup-utils');

describe('ActionCollector', () => {
  let collector;

  beforeEach(() => {
    collector = new ActionCollector();
  });

  test('list() returns empty array initially', () => {
    expect(collector.list()).toEqual([]);
  });

  test('add() stores actions and list() returns them in order', () => {
    collector.add('create', '.claude/settings.json', 'Create Claude settings');
    collector.add('modify', 'package.json', 'Add dev dependencies');
    collector.add('skip', '.cursor/rules', 'Already exists');

    const actions = collector.list();
    expect(actions).toHaveLength(3);
    expect(actions[0]).toEqual({
      type: 'create',
      path: '.claude/settings.json',
      description: 'Create Claude settings'
    });
    expect(actions[1]).toEqual({
      type: 'modify',
      path: 'package.json',
      description: 'Add dev dependencies'
    });
    expect(actions[2]).toEqual({
      type: 'skip',
      path: '.cursor/rules',
      description: 'Already exists'
    });
  });

  test('list() returns a copy, not the internal array', () => {
    collector.add('create', 'file.txt', 'Test file');
    const list1 = collector.list();
    list1.push({ type: 'modify', path: 'hack.txt', description: 'Injected' });
    expect(collector.list()).toHaveLength(1);
  });

  test('print() outputs formatted actions to stdout', () => {
    collector.add('create', '.claude/settings.json', 'Create Claude settings');
    collector.add('modify', 'package.json', 'Add dev dependencies');
    collector.add('skip', '.cursor/rules', 'Already exists');

    // Capture stdout
    const lines = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      lines.push(chunk.toString());
      return true;
    };

    try {
      collector.print();
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = lines.join('');
    // Should contain all three action types and paths
    expect(output).toContain('create');
    expect(output).toContain('.claude/settings.json');
    expect(output).toContain('modify');
    expect(output).toContain('package.json');
    expect(output).toContain('skip');
    expect(output).toContain('.cursor/rules');
  });

  test('print() handles empty collector without error', () => {
    const lines = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      lines.push(chunk.toString());
      return true;
    };

    try {
      collector.print();
    } finally {
      process.stdout.write = originalWrite;
    }

    // Should not throw; output may be empty or a "no actions" message
    expect(true).toBe(true);
  });
});

describe('isNonInteractive', () => {
  const originalEnv = { ...process.env };
  const originalIsTTY = process.stdin.isTTY;
  let originalArgv;

  beforeEach(() => {
    // Clean relevant env vars
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    // Restore TTY
    process.stdin.isTTY = true;
    // Save and clean argv
    originalArgv = process.argv;
    process.argv = ['node', 'setup.js'];
  });

  afterEach(() => {
    // Restore original env
    for (const key of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI']) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
    process.stdin.isTTY = originalIsTTY;
    process.argv = originalArgv;
  });

  test('returns true when CI env var is truthy', () => {
    process.env.CI = 'true';
    expect(isNonInteractive()).toBe(true);
  });

  test('returns true when CI env var is "1"', () => {
    process.env.CI = '1';
    expect(isNonInteractive()).toBe(true);
  });

  test('returns true when GITHUB_ACTIONS is set', () => {
    process.env.GITHUB_ACTIONS = 'true';
    expect(isNonInteractive()).toBe(true);
  });

  test('returns true when GITLAB_CI is set', () => {
    process.env.GITLAB_CI = 'true';
    expect(isNonInteractive()).toBe(true);
  });

  test('returns true when stdin is not a TTY', () => {
    process.stdin.isTTY = false;
    expect(isNonInteractive()).toBe(true);
  });

  test('returns true when stdin.isTTY is undefined', () => {
    process.stdin.isTTY = undefined;
    expect(isNonInteractive()).toBe(true);
  });

  test('returns true when --non-interactive flag is passed', () => {
    process.argv = ['node', 'setup.js', '--non-interactive'];
    expect(isNonInteractive()).toBe(true);
  });

  test('returns false when none of the conditions are met', () => {
    // All env vars deleted, TTY is true, no flag — set in beforeEach
    expect(isNonInteractive()).toBe(false);
  });

  test('returns false when CI is empty string', () => {
    process.env.CI = '';
    expect(isNonInteractive()).toBe(false);
  });
});
