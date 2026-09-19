const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const {
  SCRIPT,
  cleanupTmpDir,
  createCrLfJqWrapper,
  createMockForge,
  daysAgo,
  resolveBashCommand,
  runSmartStatus,
  toBashPath,
} = require('./smart-status.helpers');

setDefaultTimeout(20000);

function runJqFixture(commandPath) {
  return spawnSync(resolveBashCommand(), ['-c', '"$1" -n 1', '_', toBashPath(commandPath)]);
}

describe('smart-status.sh', () => {
  test('script file exists', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  test('exits with error when jq is missing', () => {
    const missingJq = path.join(os.tmpdir(), 'definitely-missing-jq-command');
    const result = runSmartStatus(['--json'], { JQ_CMD: missingJq });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/jq/i);
  });

  test('sanitizes unknown arguments in error output', () => {
    const result = runSmartStatus(['--json', 'bad;$(touch owned)']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument: bad');
    expect(result.stderr).not.toContain('touch owned');
    expect(result.stderr).not.toContain(';');
  });

  test('selects a jq command that emits genuine CRLF bytes', () => {
    const fixture = createCrLfJqWrapper();
    try {
      const directResult = runJqFixture(fixture.realJq);
      const directHasCrLf = directResult.status === 0
        && directResult.stdout.length > 0
        && Array.from(directResult.stdout.subarray(-2)).join(',') === '13,10';
      const result = runJqFixture(fixture.jqCommand);
      expect(result.status).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(Array.from(result.stdout.subarray(-2))).toEqual([0x0d, 0x0a]);
      expect(fixture.usesNativeJq).toBe(process.platform === 'win32' && directHasCrLf);
      if (fixture.usesNativeJq) expect(fixture.jqCommand).toBe(fixture.realJq);
    } finally {
      if (fixture.tmpDir) cleanupTmpDir(fixture.tmpDir);
    }
  });

  test('wraps an LF-only jq command to preserve genuine CRLF output', () => {
    const lfOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-lf-jq-'));
    const lfOnlyJq = path.join(lfOnlyDir, 'jq');
    fs.writeFileSync(lfOnlyJq, '#!/usr/bin/env bash\nprintf "1\\n"\n', { mode: 0o755 });
    const fixture = createCrLfJqWrapper({ realJq: toBashPath(lfOnlyJq) });
    try {
      const result = runJqFixture(fixture.jqCommand);
      expect(fixture.usesNativeJq).toBe(false);
      expect(result.status).toBe(0);
      expect(Array.from(result.stdout)).toEqual([0x31, 0x0d, 0x0a]);
    } finally {
      if (fixture.tmpDir) cleanupTmpDir(fixture.tmpDir);
      cleanupTmpDir(lfOnlyDir);
    }
  });

  test('propagates jq failures from the CRLF wrapper', () => {
    const failingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-failing-jq-'));
    const failingJq = path.join(failingDir, 'jq');
    fs.writeFileSync(failingJq, '#!/usr/bin/env bash\nexit 7\n', { mode: 0o755 });
    const fixture = createCrLfJqWrapper({
      forceWrapper: true,
      realJq: toBashPath(failingJq),
    });
    try {
      const result = runJqFixture(fixture.jqCommand);
      expect(result.status).toBe(7);
      expect(result.stdout.length).toBe(0);
    } finally {
      if (fixture.tmpDir) cleanupTmpDir(fixture.tmpDir);
      cleanupTmpDir(failingDir);
    }
  });

  test('strips CRLF from jq output so arithmetic comparisons do not warn', () => {
    const mockData = {
      issues: [
        { id: 'crlf', title: 'CRLF-safe issue', priority: 2, type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    };
    const { tmpDir: bdTmpDir, forgeScript: bdScript } = createMockForge(mockData);
    const jqFixture = createCrLfJqWrapper();
    try {
      const result = runSmartStatus([], {
        FORGE_CMD: toBashPath(bdScript),
        JQ_CMD: jqFixture.jqCommand,
        NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('integer expression expected');
      expect(result.stdout).toContain('crlf');
    } finally {
      cleanupTmpDir(bdTmpDir);
      if (jqFixture.tmpDir) cleanupTmpDir(jqFixture.tmpDir);
    }
  });
});
