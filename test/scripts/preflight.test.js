'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, expect, test } = require('bun:test');

const {
  PROJECT_ROOT,
  cleanupTmpDir,
  resolveBashCommand,
  toBashPath,
} = require('./smart-status.helpers');

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'preflight.sh');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function makeMockBin({
  includeBd = true,
  includeGh = true,
  includeJq = true,
  bdListStatus = 0,
  bdInitStatus = 0,
  bdDoctorStatus = 0,
  ghAuthStatus = 0,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-bin-'));
  const logPath = path.join(tmpDir, 'calls.log');

  if (includeBd) {
    writeExecutable(
      path.join(tmpDir, 'bd'),
      `#!/bin/sh
printf 'bd %s\\n' "$*" >> "${toBashPath(logPath)}"
case "$1" in
  list)
    exit ${bdListStatus}
    ;;
  init)
    exit ${bdInitStatus}
    ;;
  doctor)
    exit ${bdDoctorStatus}
    ;;
  *)
    exit 64
    ;;
esac
`,
    );
  }

  if (includeGh) {
    writeExecutable(
      path.join(tmpDir, 'gh'),
      `#!/bin/sh
printf 'gh %s\\n' "$*" >> "${toBashPath(logPath)}"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit ${ghAuthStatus}
fi
exit 64
`,
    );
  }

  if (includeJq) {
    writeExecutable(
      path.join(tmpDir, 'jq'),
      `#!/bin/sh
printf 'jq %s\\n' "$*" >> "${toBashPath(logPath)}"
exit 0
`,
    );
  }

  return { tmpDir, logPath };
}

function resolvePreflightBashCommand() {
  const command = resolveBashCommand();
  if (path.isAbsolute(command)) {
    return command;
  }

  const probe = spawnSync(command, ['-lc', 'command -v bash'], {
    encoding: 'utf-8',
  });
  return (probe.stdout || '').trim() || command;
}

function runPreflight(env = {}) {
  const result = spawnSync(resolvePreflightBashCommand(), [toBashPath(SCRIPT)], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: {
      ...process.env,
      ...env,
    },
  });

  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function readCalls(logPath) {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

function makeMockPathEnv(tmpDir) {
  const pathValue = toBashPath(tmpDir);
  return process.platform === 'win32'
    ? { PATH: pathValue, Path: pathValue }
    : { PATH: pathValue };
}

describe('scripts/preflight.sh', () => {
  test('exits 0 when tools, GitHub auth, Beads init, and doctor are healthy', () => {
    const { tmpDir, logPath } = makeMockBin();
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('OK tool bd');
      expect(result.stdout).toContain('OK tool jq');
      expect(result.stdout).toContain('OK tool gh');
      expect(result.stdout).toContain('OK github-auth');
      expect(result.stdout).toContain('OK beads-init');
      expect(result.stdout).toContain('OK beads-doctor');

      const calls = readCalls(logPath);
      expect(calls).toContain('gh auth status');
      expect(calls).toContain('bd list --json --limit 1');
      expect(calls).toContain('bd doctor --fix --yes');
      expect(calls).not.toContain('bd init');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('runs bd init and exits 1 when Beads is not initialized', () => {
    const { tmpDir, logPath } = makeMockBin({ bdListStatus: 1 });
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FIXED beads-init');
      expect(result.stdout).toContain('FIXED beads-doctor');

      const calls = readCalls(logPath);
      expect(calls).toContain('bd list --json --limit 1');
      expect(calls).toContain('bd init --database forge --prefix forge');
      expect(calls).toContain('bd doctor --fix --yes');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('exits 2 with Windows guidance when gh is missing', () => {
    const { tmpDir } = makeMockBin({ includeGh: false });
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('ACTION tool gh');
      expect(result.stdout).toContain('winget install GitHub.cli');
      expect(result.stdout).not.toContain('OK github-auth');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('exits 2 with Windows guidance when bd and jq are missing', () => {
    const { tmpDir, logPath } = makeMockBin({ includeBd: false, includeJq: false });
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('ACTION tool bd');
      expect(result.stdout).toContain('bunx forge setup --quick');
      expect(result.stdout).toContain('ACTION tool jq');
      expect(result.stdout).toContain('winget install jqlang.jq');
      expect(readCalls(logPath)).not.toContain('bd ');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('exits 2 with login guidance when GitHub auth is unavailable', () => {
    const { tmpDir } = makeMockBin({ ghAuthStatus: 1 });
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('ACTION github-auth');
      expect(result.stdout).toContain('gh auth login');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});
