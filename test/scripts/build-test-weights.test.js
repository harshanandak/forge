'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, expect, test } = require('bun:test');

const { buildWeightTable, parseArgs } = require('../../scripts/build-test-weights');

const TIMEOUT_MS = 5000;

describe('build-test-weights', () => {
  test('maps the CSV columns to per-OS weights keyed by sorted normalized path', () => {
    const csv = [
      'file,windows_ms,ubuntu_ms,macos_ms,win_minus_ubuntu_ms,ratio',
      'test/z.test.js,300,100,200,200,3.0',
      'test\\a.test.js,30.4,10,20,20,3.0',
      '',
    ].join('\r\n');
    expect(buildWeightTable(csv, { date: '2026-09-28', runId: 1 })).toEqual({
      version: 1,
      source: { date: '2026-09-28', runId: '1' },
      files: {
        'test/a.test.js': { linux: 10, macos: 20, windows: 30 },
        'test/z.test.js': { linux: 100, macos: 200, windows: 300 },
      },
    });
  }, TIMEOUT_MS);

  test('rejects a missing column or a bad timing', () => {
    expect(() => buildWeightTable('file,windows_ms,ubuntu_ms\nx,1,2', { date: 'd', runId: 1 }))
      .toThrow(/missing the macos_ms column/);
    expect(() => buildWeightTable('file,windows_ms,ubuntu_ms,macos_ms\nx,1,2,', { date: 'd', runId: 1 }))
      .toThrow(/Invalid macos_ms for x/);
  }, TIMEOUT_MS);

  test('requires the source metadata', () => {
    expect(() => parseArgs(['--csv', 'x.csv', '--run-id', '1'])).toThrow(/--date is required/);
  }, TIMEOUT_MS);

  test('the committed table is a well-formed version 1 table', () => {
    const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'test-weights.json'), 'utf8'));
    expect(table.version).toBe(1);
    expect(table.source.runId).toBe('36401362381');
    const keys = Object.keys(table.files);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    for (const weights of Object.values(table.files)) {
      expect(Object.keys(weights).sort()).toEqual(['linux', 'macos', 'windows']);
    }
  }, TIMEOUT_MS);
});
