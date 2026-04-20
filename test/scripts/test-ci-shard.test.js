'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  PROFILE_MAX_AGE_MS,
  createDurationMap,
  getShardPlan,
  listAllUnitTests,
  readNewestProfile,
  selectModuloShard,
  selectRuntimeBalancedShard,
} = require('../../scripts/test-ci-shard');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-ci-shard-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe('scripts/test-ci-shard.js', () => {
  test('falls back to deterministic modulo sharding without profile data', () => {
    const files = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
    expect(selectModuloShard(files, 1, 2)).toEqual(['test/b.test.js', 'test/d.test.js']);
  });

  test('reads the newest fresh profile and ignores stale files', () => {
    const dir = makeTempDir();
    const now = Date.parse('2026-04-17T12:00:00.000Z');
    fs.writeFileSync(path.join(dir, 'stale.profile.json'), JSON.stringify({
      slowestFiles: [{ durationMs: 999, file: 'test/stale.test.js' }],
      timestamp: '2026-03-01T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(dir, 'fresh.profile.json'), JSON.stringify({
      allFileDurations: [{ durationMs: 1234, file: 'test/fresh.test.js' }],
      timestamp: '2026-04-17T10:00:00.000Z',
    }));

    const profile = readNewestProfile(dir, { maxAgeMs: PROFILE_MAX_AGE_MS, now });
    expect(profile.allFileDurations[0]).toEqual({ durationMs: 1234, file: 'test/fresh.test.js' });
  });

  test('createDurationMap prefers full file durations when available', () => {
    const durationMap = createDurationMap({
      allFileDurations: [
        { durationMs: 9000, file: 'test/slow-a.test.js' },
        { durationMs: 8000, file: 'test/slow-b.test.js' },
        { durationMs: 2000, file: 'test/fast-c.test.js' },
        { durationMs: 1000, file: 'test/fast-d.test.js' },
      ],
      slowestFiles: [
        { durationMs: 9000, file: 'test/slow-a.test.js' },
      ],
    });

    expect(durationMap.get('test/slow-a.test.js')).toBe(9000);
    expect(durationMap.get('test/slow-b.test.js')).toBe(8000);
    expect(durationMap.get('test/fast-c.test.js')).toBe(2000);
    expect(durationMap.get('test/fast-d.test.js')).toBe(1000);
  });

  test('runtime-balanced sharding distributes weighted files deterministically', () => {
    const durationMap = createDurationMap({
      allFileDurations: [
        { durationMs: 9000, file: 'test/slow-a.test.js' },
        { durationMs: 8000, file: 'test/slow-b.test.js' },
        { durationMs: 2000, file: 'test/fast-c.test.js' },
        { durationMs: 1000, file: 'test/fast-d.test.js' },
      ],
    });
    const files = ['test/fast-c.test.js', 'test/slow-b.test.js', 'test/fast-d.test.js', 'test/slow-a.test.js'];

    expect(selectRuntimeBalancedShard(files, 0, 2, durationMap)).toEqual([
      'test/fast-d.test.js',
      'test/slow-a.test.js',
    ]);
    expect(selectRuntimeBalancedShard(files, 1, 2, durationMap)).toEqual([
      'test/fast-c.test.js',
      'test/slow-b.test.js',
    ]);
  });

  test('getShardPlan reports runtime-balanced source when durations exist', () => {
    const plan = getShardPlan({
      label: 'unit',
      mode: 'shard',
      shardIndex: 0,
      shardTotal: 2,
    }, {
      allUnitTests: ['test/a.test.js', 'test/b.test.js'],
      durationMap: new Map([
        ['test/a.test.js', 5000],
        ['test/b.test.js', 1000],
      ]),
    });

    expect(plan.source).toBe('runtime-balanced');
    expect(plan.files).toEqual(['test/a.test.js']);
  });

  test('listAllUnitTests includes package test roots for shard planning', () => {
    const files = listAllUnitTests();
    expect(files).toContain('packages/skills/test/agents.test.js');
    expect(files).toContain('test/agent-detection.test.js');
  });
});
