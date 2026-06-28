'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, expect, test } = require('bun:test');

const {
  BASH_PATH_ENV,
  PROJECT_ROOT,
  cleanupTmpDir,
  resolveBashCommand,
  toBashPath,
} = require('./smart-status.helpers');

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'preflight.sh');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function writeUtilityShim(binDir, name) {
  writeExecutable(
    path.join(binDir, name),
    `#!/bin/sh
PATH="${BASH_PATH_ENV}"
export PATH
exec ${name} "$@"
`,
  );
}

function makeMockBin({
  includeNode = true,
  includeGh = true,
  includeJq = true,
  kernelListStatus = 0,
  kernelDoctorStatus = 0,
  ghAuthStatus = 0,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-bin-'));
  const logPath = path.join(tmpDir, 'calls.log');

  for (const tool of ['chmod', 'cp', 'find', 'git', 'grep', 'mkdir', 'mktemp', 'rm', 'tr']) {
    writeUtilityShim(tmpDir, tool);
  }

  if (includeNode) {
    // The kernel checks run `node <forge.js> issue list --json` and
    // `node <forge.js> doctor`. $2 is the forge subcommand.
    writeExecutable(
      path.join(tmpDir, 'node'),
      `#!/bin/sh
printf 'node %s\\n' "$*" >> "${toBashPath(logPath)}"
case "$2" in
  issue)
    exit ${kernelListStatus}
    ;;
  doctor)
    exit ${kernelDoctorStatus}
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

function runPreflight(env = {}, cwd = PROJECT_ROOT) {
  const result = spawnSync(resolvePreflightBashCommand(), [toBashPath(SCRIPT)], {
    cwd,
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
  test('exits 0 when tools, GitHub auth, and the kernel are healthy', () => {
    const { tmpDir, logPath } = makeMockBin();
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('OK tool jq');
      expect(result.stdout).toContain('OK tool gh');
      expect(result.stdout).toContain('OK github-auth');
      expect(result.stdout).toContain('OK kernel-init');
      expect(result.stdout).toContain('OK kernel-doctor');

      const calls = readCalls(logPath);
      expect(calls).toContain('gh auth status');
      expect(calls).toContain('issue list --json');
      expect(calls).toContain('doctor');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('exits 2 when the kernel issue store is not initializable', () => {
    const { tmpDir, logPath } = makeMockBin({ kernelListStatus: 1 });
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('ACTION kernel-init');
      // doctor only runs after a readable kernel, so it must NOT be invoked here
      expect(result.stdout).not.toContain('kernel-doctor');
      const calls = readCalls(logPath);
      expect(calls).toContain('issue list --json');
      expect(calls).not.toContain('doctor');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  test('exits 2 when forge doctor reports an unhealthy filesystem', () => {
    const { tmpDir } = makeMockBin({ kernelDoctorStatus: 1 });
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('OK kernel-init');
      expect(result.stdout).toContain('ACTION kernel-doctor');
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

  test('exits 2 with Windows guidance when jq is missing', () => {
    const { tmpDir, logPath } = makeMockBin({ includeJq: false });
    try {
      const result = runPreflight(makeMockPathEnv(tmpDir));

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('ACTION tool jq');
      expect(result.stdout).toContain('winget install jqlang.jq');
      // bd is no longer a checked tool
      expect(result.stdout).not.toContain('tool bd');
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
