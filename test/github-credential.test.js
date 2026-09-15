'use strict';

const { describe, test, expect } = require('bun:test');
const { runCredentialHelper } = require('../lib/github-credential');

describe('Forge GitHub credential helper', () => {
  test.each([
    ['get', 'protocol=ssh\nhost=github.com\n\n'],
    ['get', 'protocol=https\nhost=gitlab.com\n\n'],
    ['get', 'protocol=https\nhost=github.com:444\n\n'],
    ['get', 'protocol=https\nhost=github.com.evil.example\n\n'],
    ['store', 'protocol=https\nhost=github.com\n\n'],
    ['erase', 'protocol=https\nhost=github.com\n\n'],
  ])('ignores unsupported request %s without resolving an account', (operation, input) => {
    let prepared = false;
    const output = [];
    const result = runCredentialHelper(operation, {
      projectRoot: '/repo', input, write: value => output.push(value),
      readAuto: () => true,
      createContext: () => { prepared = true; },
    });
    expect(result).toBe(0);
    expect(output).toEqual([]);
    expect(prepared).toBe(false);
  });

  test('accepts github.com case-insensitively', () => {
    let prepared = false;
    const context = {};
    Object.defineProperty(context, 'writeCredential', {
      enumerable: false,
      value: write => write('username=work\npassword=test-only-secret\n\n'),
    });
    expect(runCredentialHelper('get', {
      projectRoot: '/repo', input: 'protocol=https\nhost=GitHub.com\n\n', write: () => {},
      readAuto: () => true, createContext: () => { prepared = true; return context; },
    })).toBe(0);
    expect(prepared).toBe(true);
  });

  test('accepts the default HTTPS port', () => {
    let prepared = false;
    const context = { writeCredential: () => {} };
    expect(runCredentialHelper('get', {
      projectRoot: '/repo', input: 'protocol=https\nhost=GitHub.com:443\n\n', write: () => {},
      readAuto: () => true, createContext: () => { prepared = true; return context; },
    })).toBe(0);
    expect(prepared).toBe(true);
  });

  test('writes the selected credential only to the credential protocol sink', () => {
    const output = [];
    const context = {};
    Object.defineProperty(context, 'writeCredential', {
      enumerable: false,
      value: write => write('username=work\npassword=test-only-secret\n\n'),
    });

    const result = runCredentialHelper('get', {
      projectRoot: '/repo', input: 'protocol=https\nhost=github.com\n\n',
      write: value => output.push(value), readAuto: () => true,
      createContext: () => context,
    });

    expect(result).toBe(0);
    expect(output).toEqual(['username=work\npassword=test-only-secret\n\n']);
    expect(JSON.stringify(context)).not.toContain('test-only-secret');
  });

  test('fails closed and keeps account failures secret-clean', () => {
    const output = [];
    const errors = [];
    const result = runCredentialHelper('get', {
      projectRoot: '/repo', input: 'protocol=https\nhost=github.com\n\n',
      write: value => output.push(value), writeError: value => errors.push(value),
      readAuto: () => true,
      createContext: () => { throw new Error('test-only-secret'); },
    });

    expect(result).toBe(1);
    expect(output).toEqual(['quit=true\n\n']);
    expect(errors.join('')).toContain('forge github status');
    expect(errors.join('')).not.toContain('test-only-secret');
  });

  test('resolves the named native account without a per-request live identity call', () => {
    const calls = [];
    const output = [];
    const before = { ...process.env };
    const runner = (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command !== 'git') {
        if (args[0] === 'auth') return 'token-canary\n';
        throw new Error('live identity lookup should not run');
      }
      if (args.includes('--get-all') && args.at(-1) === 'github.auto') return 'true\n';
      if (args.includes('--get-all') && args.at(-1) === 'github.account') return 'work\n';
      throw Object.assign(new Error('missing'), { status: 1 });
    };

    expect(runCredentialHelper('get', {
      projectRoot: '/repo', input: 'protocol=https\nhost=github.com\n\n',
      runner, assertRegistered: () => true, write: value => output.push(value),
      baseEnv: { GH_TOKEN: 'ambient-token', GH_HOST: 'evil.example' },
    })).toBe(0);
    expect(output).toEqual(['username=work\npassword=token-canary\n\n']);
    expect(calls.filter(call => call.command === 'gh')).toHaveLength(1);
    expect(calls[0].options.env).not.toHaveProperty('GH_TOKEN');
    expect(calls[0].options.env).not.toHaveProperty('GH_HOST');
    expect({ ...process.env }).toEqual(before);
  });

  test('fails closed for malformed or duplicate automatic routing values', () => {
    for (const values of [['enabled'], ['true', 'true']]) {
      const output = [];
      const errors = [];
      const runner = (command, args) => {
        if (command !== 'git') throw new Error('native account must not be queried');
        if (args.includes('--get-all') && args.at(-1) === 'github.auto') return `${values.join('\n')}\n`;
        throw Object.assign(new Error('missing'), { status: 1 });
      };
      expect(runCredentialHelper('get', {
        projectRoot: '/repo', input: 'protocol=https\nhost=github.com\n\n', runner,
        write: value => output.push(value), writeError: value => errors.push(value),
      })).toBe(1);
      expect(output).toEqual(['quit=true\n\n']);
      expect(errors.join('')).toContain('forge github status');
    }
  });

  test.each([
    ['missing registry', 'registry file is missing'],
    ['corrupt registry', 'registry file is corrupt'],
    ['unregistered clone', 'clone is not registered'],
  ])('fails closed for %s before resolving a token', (_label, message) => {
    const calls = [];
    const output = [];
    const errors = [];
    const runner = (command, args) => {
      calls.push({ command, args });
      if (command === 'gh') return 'token-canary\n';
      if (args.includes('--get-all') && args.at(-1) === 'github.account') return 'work\n';
      throw Object.assign(new Error('missing'), { status: 1 });
    };

    expect(runCredentialHelper('get', {
      projectRoot: '/repo', input: 'protocol=https\nhost=github.com\n\n', runner,
      readAuto: () => true, assertRegistered: () => { throw new Error(message); },
      write: value => output.push(value), writeError: value => errors.push(value),
    })).toBe(1);
    expect(output).toEqual(['quit=true\n\n']);
    expect(errors.join('')).toContain('forge github status');
    expect(calls.filter(call => call.command === 'gh')).toHaveLength(0);
  });

});
