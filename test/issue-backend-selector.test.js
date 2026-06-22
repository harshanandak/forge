'use strict';

const { describe, test, expect } = require('bun:test');

const {
  resolveIssueBackend,
  VALID_BACKENDS,
} = require('../lib/issue-backend-selector');

describe('resolveIssueBackend — precedence + equivalence', () => {
  test('default is beads when nothing is set', () => {
    const result = resolveIssueBackend({ flags: {}, env: {}, config: {} });
    expect(result).toEqual({
      issueBackend: 'beads',
      useKernelBroker: false,
      source: 'default',
    });
  });

  test('--kernel boolean flag selects kernel (source: flag)', () => {
    const result = resolveIssueBackend({ flags: { kernel: true }, env: {}, config: {} });
    expect(result).toEqual({
      issueBackend: 'kernel',
      useKernelBroker: true,
      source: 'flag',
    });
  });

  test('--issue-backend kernel is equivalent to --kernel', () => {
    const viaKernel = resolveIssueBackend({ flags: { kernel: true }, env: {}, config: {} });
    const viaBackend = resolveIssueBackend({ flags: { issueBackend: 'kernel' }, env: {}, config: {} });
    expect(viaBackend.issueBackend).toBe(viaKernel.issueBackend);
    expect(viaBackend.useKernelBroker).toBe(viaKernel.useKernelBroker);
    expect(viaBackend.source).toBe('flag');
  });

  test('--issue-backend beads selects beads explicitly (source: flag)', () => {
    const result = resolveIssueBackend({ flags: { issueBackend: 'beads' }, env: {}, config: {} });
    expect(result).toEqual({
      issueBackend: 'beads',
      useKernelBroker: false,
      source: 'flag',
    });
  });

  test('flag overrides env', () => {
    const result = resolveIssueBackend({
      flags: { kernel: true },
      env: { FORGE_ISSUE_BACKEND: 'beads' },
      config: {},
    });
    expect(result.issueBackend).toBe('kernel');
    expect(result.source).toBe('flag');
  });

  test('env overrides config', () => {
    const result = resolveIssueBackend({
      flags: {},
      env: { FORGE_ISSUE_BACKEND: 'kernel' },
      config: { issueBackend: 'beads' },
    });
    expect(result.issueBackend).toBe('kernel');
    expect(result.source).toBe('env');
  });

  test('config used when flag and env absent', () => {
    const result = resolveIssueBackend({
      flags: {},
      env: {},
      config: { issueBackend: 'kernel' },
    });
    expect(result.issueBackend).toBe('kernel');
    expect(result.useKernelBroker).toBe(true);
    expect(result.source).toBe('config');
  });
});

describe('resolveIssueBackend — conflict + validation errors', () => {
  test('--kernel + --issue-backend beads is a mutually-exclusive conflict', () => {
    expect(() =>
      resolveIssueBackend({ flags: { kernel: true, issueBackend: 'beads' }, env: {}, config: {} }),
    ).toThrow(/conflict|mutually.exclusive/i);
  });

  test('--kernel + --issue-backend kernel is allowed (no conflict, same target)', () => {
    const result = resolveIssueBackend({
      flags: { kernel: true, issueBackend: 'kernel' },
      env: {},
      config: {},
    });
    expect(result.issueBackend).toBe('kernel');
    expect(result.source).toBe('flag');
  });

  test('unknown --issue-backend value throws listing valid values', () => {
    expect(() =>
      resolveIssueBackend({ flags: { issueBackend: 'sqlite' }, env: {}, config: {} }),
    ).toThrow(/sqlite/);
  });

  test('unknown FORGE_ISSUE_BACKEND value throws listing valid values', () => {
    let captured;
    try {
      resolveIssueBackend({ flags: {}, env: { FORGE_ISSUE_BACKEND: 'mongo' }, config: {} });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    expect(captured.message).toContain('beads');
    expect(captured.message).toContain('kernel');
  });

  test('unknown config issueBackend value throws', () => {
    expect(() =>
      resolveIssueBackend({ flags: {}, env: {}, config: { issueBackend: 'foo' } }),
    ).toThrow(/foo/);
  });

  test('VALID_BACKENDS exposes the canonical backend names', () => {
    expect(VALID_BACKENDS).toContain('beads');
    expect(VALID_BACKENDS).toContain('kernel');
  });
});

describe('resolveIssueBackend — input robustness', () => {
  test('empty/whitespace env value falls through to next source', () => {
    const result = resolveIssueBackend({
      flags: {},
      env: { FORGE_ISSUE_BACKEND: '   ' },
      config: { issueBackend: 'kernel' },
    });
    expect(result.issueBackend).toBe('kernel');
    expect(result.source).toBe('config');
  });

  test('case-insensitive env value (KERNEL) is accepted', () => {
    const result = resolveIssueBackend({
      flags: {},
      env: { FORGE_ISSUE_BACKEND: 'KERNEL' },
      config: {},
    });
    expect(result.issueBackend).toBe('kernel');
    expect(result.source).toBe('env');
  });

  test('missing argument object defaults cleanly to beads', () => {
    const result = resolveIssueBackend();
    expect(result.issueBackend).toBe('beads');
    expect(result.source).toBe('default');
  });
});
