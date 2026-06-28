const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const {
  BASH_PATH_ENV,
  SCRIPT,
  cleanupTmpDir,
  createCrLfJqWrapper,
  createMockForge,
  daysAgo,
  runSmartStatus,
  toBashPath,
} = require('./smart-status.helpers');

setDefaultTimeout(20000);

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

  test('strips CRLF from jq output so arithmetic comparisons do not warn', () => {
    const mockData = {
      issues: [
        { id: 'crlf', title: 'CRLF-safe issue', priority: 2, type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    };
    const { tmpDir: bdTmpDir, forgeScript: bdScript } = createMockForge(mockData);
    const { tmpDir: jqTmpDir } = createCrLfJqWrapper();
    try {
      const result = runSmartStatus([], {
        FORGE_CMD: toBashPath(bdScript),
        PATH: `${toBashPath(jqTmpDir)}:${BASH_PATH_ENV}`,
        NO_COLOR: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('integer expression expected');
      expect(result.stdout).toContain('crlf');
    } finally {
      cleanupTmpDir(bdTmpDir);
      cleanupTmpDir(jqTmpDir);
    }
  });
});
