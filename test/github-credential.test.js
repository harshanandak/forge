'use strict';

const { describe, test, expect } = require('bun:test');
const { runCredentialHelper } = require('../lib/github-credential');

describe('Forge GitHub credential helper', () => {
  test.each([
    ['get', 'protocol=ssh\nhost=github.com\n\n'],
    ['get', 'protocol=https\nhost=gitlab.com\n\n'],
    ['get', 'protocol=https\nhost=github.com:443\n\n'],
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
});
