'use strict';

const { describe, expect, mock, test } = require('bun:test');
const contracts = require('../../memory-contracts');
mock.module('@forge/memory-contracts', () => contracts);
const {
  MEMORY_AUTHORITY_METHODS,
  assertMemoryAuthorityProvider,
  createMemoryAuthorityProvider,
} = require('..');

function brokerStub(calls) {
  return Object.fromEntries(MEMORY_AUTHORITY_METHODS.map(method => [method, async (...args) => {
    calls.push({ method, args });
    if (method === 'initialize') {
      return {
        success: true,
        mode: 'local',
        databasePath: 'C:\\Users\\alice\\private.sqlite',
        gitCommonDir: 'C:\\Users\\alice\\repo\\.git',
        migrationsApplied: ['001'],
      };
    }
    return { method, args };
  }]));
}

describe('Memory authority provider', () => {
  test('exposes the existing Kernel authority primitives through one frozen public seam', async () => {
    const calls = [];
    const broker = brokerStub(calls);
    broker.config = { databasePath: 'private.sqlite' };
    const provider = createMemoryAuthorityProvider({ broker });

    expect(Object.keys(provider)).toEqual([...MEMORY_AUTHORITY_METHODS]);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(provider.config).toBeUndefined();
    expect(await provider.initialize()).toEqual({
      success: true,
    });
    await provider.runIssueOperation('show', ['issue-1'], { actor: 'agent-1' });
    await provider.runGuardedEvent({ type: 'run.accepted' }, { actor: 'agent-1' });

    expect(calls).toEqual([
      { method: 'initialize', args: [] },
      { method: 'runIssueOperation', args: ['show', ['issue-1'], { actor: 'agent-1' }] },
      { method: 'runGuardedEvent', args: [{ type: 'run.accepted' }, { actor: 'agent-1' }] },
    ]);
    expect(assertMemoryAuthorityProvider(provider)).toBe(provider);
  });

  test('fails closed when an authority primitive is missing', () => {
    const broker = brokerStub([]);
    delete broker.runGuardedEvent;
    expect(() => createMemoryAuthorityProvider({ broker })).toThrow('runGuardedEvent()');
  });

  test('rejects an unstructured initialization result instead of leaking it', async () => {
    const broker = brokerStub([]);
    broker.initialize = async () => 'C:\\Users\\alice\\private.sqlite';
    const provider = createMemoryAuthorityProvider({ broker });

    await expect(provider.initialize()).rejects.toThrow('must return an object');
  });
});
