'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-dashboard-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('scripts/test-dashboard.js profile aggregation', () => {
  test('aggregates suite duration, slowest files, timeouts, and benchmark metadata from profile artifacts', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'a.profile.json'), JSON.stringify({
      allFileDurations: [
        { durationMs: 5000, file: 'test/a.test.js' },
        { durationMs: 1000, file: 'test/b.test.js' },
      ],
      integrationSkipped: true,
      slowestFiles: [
        { durationMs: 5000, file: 'test/a.test.js' },
      ],
      suiteDurationMs: 6000,
      timedOutFiles: ['test/a.test.js'],
      timestamp: '2026-04-18T00:00:00.000Z',
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'b.profile.json'), JSON.stringify({
      allFileDurations: [
        { durationMs: 2000, file: 'test/c.test.js' },
        { durationMs: 1500, file: 'test/a.test.js' },
      ],
      integrationSkipped: false,
      slowestFiles: [
        { durationMs: 2000, file: 'test/c.test.js' },
      ],
      suiteDurationMs: 3500,
      timedOutFiles: ['test/c.test.js'],
      timestamp: '2026-04-18T00:01:00.000Z',
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'benchmark-results.json'), JSON.stringify({
      groups: [
        { groupId: 'full-suite', groupLabel: 'Whole suite', medianMs: 250000 },
        { groupId: 'validate', groupLabel: 'Validate command', medianMs: 280000 },
      ],
      slowestGroup: { groupId: 'validate', groupLabel: 'Validate command', medianMs: 280000 },
      totalMedianMs: 530000,
      timestamp: '2026-04-18T00:02:00.000Z',
    }, null, 2));

    const dashboardModulePath = path.join(__dirname, '..', '..', 'scripts', 'test-dashboard.js');
    const previousArgv = process.argv;
    const previousCache = require.cache[dashboardModulePath];
    process.argv = ['node', 'test-dashboard.js', '--json', '--profiles-dir', dir];
    delete require.cache[dashboardModulePath];

    let dashboard;
    try {
      dashboard = require(dashboardModulePath);
    } finally {
      process.argv = previousArgv;
      delete require.cache[dashboardModulePath];
      if (previousCache) {
        require.cache[dashboardModulePath] = previousCache;
      }
    }

    expect(dashboard.suiteDurationMs).toBe(9500);
    expect(dashboard.integrationSkipped).toBe(true);
    expect(dashboard.timedOutFiles).toEqual(['test/a.test.js', 'test/c.test.js']);
    expect(dashboard.slowestFiles).toEqual([
      { durationMs: 5000, file: 'test/a.test.js' },
      { durationMs: 2000, file: 'test/c.test.js' },
      { durationMs: 1000, file: 'test/b.test.js' },
    ]);
    expect(dashboard.benchmarks.totalMedianMs).toBe(530000);
    expect(dashboard.benchmarks.slowestGroup).toEqual({
      groupId: 'validate',
      groupLabel: 'Validate command',
      medianMs: 280000,
    });
  });
});
