'use strict';

const { describe, test, expect } = require('bun:test');

const {
  resolveSyncBackend,
  createSyncBackend,
  LocalNoopSyncBackend,
  DEFAULT_BACKEND,
} = require('../lib/sync-backend');

// ---------------------------------------------------------------------------
// SyncBackend seam — test/sync-backend.test.js
//
// Mirrors lib/issue-backend.js: precedence resolver + a default backend that
// ships today (local-noop). git-jsonl/server are documented swap targets that
// must fail honestly until their PRs land.
// ---------------------------------------------------------------------------

describe('resolveSyncBackend', () => {
  test('defaults to local-noop with no signal', () => {
    expect(resolveSyncBackend({ env: {} })).toBe('local-noop');
    expect(DEFAULT_BACKEND).toBe('local-noop');
  });

  test('honors precedence: deps > env > config', () => {
    // env present but deps wins
    expect(
      resolveSyncBackend({ deps: { syncBackend: 'server' }, env: { FORGE_SYNC_BACKEND: 'git-jsonl' } }),
    ).toBe('server');
    // env used when no deps
    expect(resolveSyncBackend({ env: { FORGE_SYNC_BACKEND: 'git-jsonl' } })).toBe('git-jsonl');
  });

  test('normalizes case', () => {
    expect(resolveSyncBackend({ env: { FORGE_SYNC_BACKEND: 'Git-JSONL' } })).toBe('git-jsonl');
  });

  test('falls back to default and warns on an unknown value', () => {
    const warnings = [];
    const result = resolveSyncBackend({
      env: { FORGE_SYNC_BACKEND: 'bogus' },
      warn: (m) => warnings.push(m),
    });
    expect(result).toBe('local-noop');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('bogus');
  });
});

describe('createSyncBackend', () => {
  test('returns the local-noop backend by default', () => {
    const backend = createSyncBackend({ env: {} });
    expect(backend).toBe(LocalNoopSyncBackend);
    expect(backend.name).toBe('local-noop');
  });

  test('honors an explicit backend override', () => {
    expect(createSyncBackend({ backend: 'local-noop' }).name).toBe('local-noop');
  });

  test('throws an honest "not implemented" for git-jsonl and server', () => {
    expect(() => createSyncBackend({ backend: 'git-jsonl' })).toThrow(/not implemented/i);
    expect(() => createSyncBackend({ backend: 'server' })).toThrow(/not implemented/i);
  });
});

describe('LocalNoopSyncBackend', () => {
  test('sync() is a graceful no-op naming the model', async () => {
    const result = await LocalNoopSyncBackend.sync({ projectRoot: '/x' });
    expect(result.success).toBe(true);
    expect(result.synced).toBe(false);
    expect(result.message).toContain('single-machine authority');
    // never leaks a bd/dolt token in the user-facing message
    expect(result.message.toLowerCase()).not.toMatch(/\bbd\b|\bdolt\b|\.beads/);
  });

  test('push() reports nothing to push, preserving protocol buckets', async () => {
    const result = await LocalNoopSyncBackend.push({});
    expect(result).toEqual({ pushed: 0, accepted: [], duplicate: [], quarantine: [] });
  });

  test('pull() reports nothing applied', async () => {
    const result = await LocalNoopSyncBackend.pull({});
    expect(result).toEqual({ pulled: 0, appliedThrough: null });
  });

  test('status() reports no remote configured', async () => {
    const result = await LocalNoopSyncBackend.status({});
    expect(result.configured).toBe(false);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });
});
