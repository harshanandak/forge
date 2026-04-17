'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  buildProfile,
  main,
  normalizePathForProfile,
  parseJUnitFiles,
} = require('../../scripts/test-profile');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-profile-'));
  tempDirs.push(dir);
  return dir;
}

function writeXml(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe('scripts/test-profile.js', () => {
  test('normalizes Windows paths for deterministic output', () => {
    expect(normalizePathForProfile('test\\scripts\\smart-status.test.js')).toBe('test/scripts/smart-status.test.js');
  });

  test('parseJUnitFiles preserves duration outputs and adds heuristic buckets', () => {
    const dir = makeTempDir();
    writeXml(dir, 'profile.xml', `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite-a" time="3.5">
    <testcase classname="smart-status" name="spawns bash process" file="test\\scripts\\smart-status.basics.test.js" time="1.2"></testcase>
    <testcase classname="profile" name="loads fixture workspace" file="test/e2e/fixtures/setup.test.js" time="2.3"><failure>timeout waiting</failure></testcase>
  </testsuite>
</testsuites>`);

    const metrics = parseJUnitFiles([path.join(dir, 'profile.xml')]);

    expect(metrics.suiteDurationMs).toBe(3500);
    expect(metrics.slowestFiles[0]).toEqual({
      durationMs: 2300,
      file: 'test/e2e/fixtures/setup.test.js',
    });
    expect(metrics.timedOutFiles).toEqual(['test/e2e/fixtures/setup.test.js']);
    expect(metrics.pathBuckets.scripts).toEqual({ durationMs: 1200, files: 1, testCases: 1 });
    expect(metrics.pathBuckets.fixtures).toEqual({ durationMs: 2300, files: 1, testCases: 1 });
    expect(metrics.shellHeavy.matchedFiles).toBe(1);
    expect(metrics.shellHeavy.matchedTestCases).toBe(1);
    expect(metrics.shellHeavy.durationMs).toBe(1200);
    expect(metrics.fixtureHeavy.matchedFiles).toBe(1);
    expect(metrics.fixtureHeavy.matchedTestCases).toBe(1);
    expect(metrics.fixtureHeavy.durationMs).toBe(2300);
  });

  test('buildProfile keeps additive fields for empty inputs', () => {
    const profile = buildProfile({ integrationSkipped: true, label: 'local' }, parseJUnitFiles([]), '2026-04-17T00:00:00.000Z');

    expect(profile).toMatchObject({
      fixtureHeavy: {
        durationMs: 0,
        matchedFiles: 0,
        matchedTestCases: 0,
        topFiles: [],
      },
      integrationSkipped: true,
      label: 'local',
      shellHeavy: {
        durationMs: 0,
        matchedFiles: 0,
        matchedTestCases: 0,
        topFiles: [],
      },
      slowestFiles: [],
      suiteDurationMs: 0,
      timedOutFiles: [],
      timestamp: '2026-04-17T00:00:00.000Z',
    });
    expect(profile.pathBuckets.other).toEqual({ durationMs: 0, files: 0, testCases: 0 });
  });

  test('main writes JSON output with new heuristic fields', () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'profile.json');
    writeXml(dir, 'cli.xml', `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite-b" time="1.0">
    <testcase classname="commands" name="runs cli command" file="test/commands/test.test.js" time="1.0"></testcase>
  </testsuite>
</testsuites>`);

    const chunks = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };

    try {
      main(['--input-dir', dir, '--output', outputPath, '--label', 'cli']);
    } finally {
      process.stdout.write = write;
    }

    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const printed = JSON.parse(chunks.join(''));
    expect(written.label).toBe('cli');
    expect(written.pathBuckets.commands).toEqual({ durationMs: 1000, files: 1, testCases: 1 });
    expect(written.shellHeavy.matchedFiles).toBe(1);
    expect(printed).toEqual(written);
  });
});
