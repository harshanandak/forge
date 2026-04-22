const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test, expect, setDefaultTimeout } = require('bun:test');

const {
  BASH_PATH_ENV,
  PROJECT_ROOT,
  SCRIPT,
  cleanupTmpDir,
  createCrLfJqWrapper,
  createMetadataRecoveryMocks,
  createMockBd,
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
    const result = runSmartStatus(['--json'], { PATH: '' });
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

  test('hard-stops with a repair hint when bd is unavailable', () => {
    const missingBd = path.join(os.tmpdir(), 'definitely-missing-bd-command');
    const result = runSmartStatus(['--json'], { BD_CMD: missingBd });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/bd is required/i);
  });

  test('strips CRLF from jq output so arithmetic comparisons do not warn', () => {
    const mockData = {
      issues: [
        { id: 'crlf', title: 'CRLF-safe issue', priority: 2, type: 'feature', status: 'open', dependent_count: 0, updated_at: daysAgo(1) },
      ],
    };
    const { tmpDir: bdTmpDir, mockScript: bdScript } = createMockBd(mockData);
    const { tmpDir: jqTmpDir } = createCrLfJqWrapper();
    try {
      const result = runSmartStatus([], {
        BD_CMD: toBashPath(bdScript),
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

  test('uses .beads/metadata.json dolt_database for auto-recovery instead of the repo basename', () => {
    const repoRoot = fs.mkdtempSync(path.join(PROJECT_ROOT, '.tmp-basename-mismatch-'));
    const { tmpDir, bdScript, gitScript, capturePath } = createMetadataRecoveryMocks({
      repoRoot,
      databaseName: 'forge-shared-db',
    });

    try {
      const result = runSmartStatus(['--json'], {
        BD_CMD: bdScript,
        GIT_CMD: gitScript,
      });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(capturePath, 'utf8')).toContain('--prefix forge-shared-db');
      expect(fs.readFileSync(capturePath, 'utf8')).not.toContain(path.basename(repoRoot));
    } finally {
      cleanupTmpDir(tmpDir);
      cleanupTmpDir(repoRoot);
    }
  });

  test('falls back to the repo basename when .beads/metadata.json is malformed', () => {
    const repoRoot = fs.mkdtempSync(path.join(PROJECT_ROOT, '.tmp-malformed-metadata-'));
    const { tmpDir, bdScript, gitScript, capturePath } = createMetadataRecoveryMocks({
      repoRoot,
      databaseName: 'forge-shared-db',
    });

    try {
      fs.writeFileSync(path.join(repoRoot, '.beads', 'metadata.json'), '{"dolt_database":');
      const fallbackPrefix = path.basename(repoRoot)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const result = runSmartStatus(['--json'], {
        BD_CMD: bdScript,
        GIT_CMD: gitScript,
      });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(capturePath, 'utf8')).toContain(`--prefix ${fallbackPrefix}`);
      expect(fs.readFileSync(capturePath, 'utf8')).not.toContain('forge-shared-db');
    } finally {
      cleanupTmpDir(tmpDir);
      cleanupTmpDir(repoRoot);
    }
  });

  test('falls back to the repo basename when metadata only has the backend database field', () => {
    const repoRoot = fs.mkdtempSync(path.join(PROJECT_ROOT, '.tmp-backend-only-metadata-'));
    const { tmpDir, bdScript, gitScript, capturePath } = createMetadataRecoveryMocks({
      repoRoot,
      metadata: { database: 'dolt' },
    });

    try {
      const fallbackPrefix = path.basename(repoRoot)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');

      const result = runSmartStatus(['--json'], {
        BD_CMD: bdScript,
        GIT_CMD: gitScript,
      });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(capturePath, 'utf8')).toContain(`--prefix ${fallbackPrefix}`);
      expect(fs.readFileSync(capturePath, 'utf8')).not.toContain('--prefix dolt');
    } finally {
      cleanupTmpDir(tmpDir);
      cleanupTmpDir(repoRoot);
    }
  });
});
