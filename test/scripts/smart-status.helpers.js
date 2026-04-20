const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'smart-status.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const SYSTEM_PATH = process.env.PATH || process.env.Path || '';
let cachedBashCommand;
let cachedRealJq;

function resolveBashCommand() {
  if (cachedBashCommand) {
    return cachedBashCommand;
  }
  if (process.env.BASH_CMD) {
    cachedBashCommand = process.env.BASH_CMD;
    return cachedBashCommand;
  }
  if (process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)) {
    cachedBashCommand = GIT_BASH_PATH;
    return cachedBashCommand;
  }
  cachedBashCommand = 'bash';
  return cachedBashCommand;
}

function toBashPath(filePath) {
  if (process.platform !== 'win32') {
    return filePath;
  }
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function resolveBashPathEnv() {
  const probe = spawnSync(resolveBashCommand(), ['-lc', 'printf %s "$PATH"'], {
    encoding: 'utf8',
  });
  return (probe.stdout || '').trim() || SYSTEM_PATH;
}

const BASH_PATH_ENV = resolveBashPathEnv();

function normalizeBashEnv(env = {}) {
  return {
    ...env,
    ...(env.BD_CMD ? { BD_CMD: toBashPath(env.BD_CMD) } : {}),
    ...(env.GIT_CMD ? { GIT_CMD: toBashPath(env.GIT_CMD) } : {}),
    ...(env.REAL_GIT ? { REAL_GIT: toBashPath(env.REAL_GIT) } : {}),
  };
}

function runSmartStatus(args = [], env = {}, stdin = undefined) {
  const mergedEnv = {
    ...process.env,
    GIT_CMD: 'true',
    ...normalizeBashEnv(env),
  };

  if (process.platform === 'win32' && env.PATH) {
    mergedEnv.Path = env.PATH;
  }

  const result = spawnSync(resolveBashCommand(), [toBashPath(SCRIPT), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    input: stdin,
    env: mergedEnv,
  });

  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function parseIssues(stdout) {
  const parsed = JSON.parse(stdout);
  if (!parsed.issues) {
    throw new Error('Expected {sessions, issues} envelope but got: ' + stdout.slice(0, 200));
  }
  return parsed.issues;
}

function createMockBd(jsonData) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-test-'));
  const mockScript = path.join(tmpDir, 'bd');
  const scriptContent = `#!/usr/bin/env bash
if [[ "$1" == "list" ]]; then
  cat <<'JSONEOF'
${JSON.stringify(jsonData.issues || [])}
JSONEOF
elif [[ "$1" == "children" ]]; then
  EPIC_ID="$2"
  case "$EPIC_ID" in
${(jsonData.epicChildren || []).map((ec) => `    "${ec.id}") cat <<'JSONEOF'
${JSON.stringify(ec.children)}
JSONEOF
    ;;`).join('\n')}
    *) echo "[]" ;;
  esac
fi
`;
  fs.writeFileSync(mockScript, scriptContent, { mode: 0o755 });
  return { tmpDir, mockScript };
}

function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_e) {
    // ignore cleanup errors
  }
}

function createCrLfJqWrapper() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-jq-'));
  const wrapperPath = path.join(tmpDir, 'jq');
  if (!cachedRealJq) {
    const probe = spawnSync(resolveBashCommand(), ['-lc', 'command -v jq'], {
      encoding: 'utf8',
    });
    cachedRealJq = process.env.TEST_REAL_JQ
      || (probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      || 'jq';
  }
  const scriptContent = `#!/usr/bin/env bash
REAL_JQ="${cachedRealJq}"
"$REAL_JQ" "$@" | awk '{ printf "%s\\r\\n", $0 }'
`;
  fs.writeFileSync(wrapperPath, scriptContent, { mode: 0o755 });
  return { tmpDir, wrapperPath };
}

function createMetadataRecoveryMocks({ repoRoot, databaseName, metadata }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-recovery-'));
  const bdScript = path.join(tmpDir, 'bd');
  const gitScript = path.join(tmpDir, 'git');
  const capturePath = path.join(tmpDir, 'init-args.txt');
  const restoredFlag = path.join(tmpDir, 'restored.flag');

  fs.mkdirSync(path.join(repoRoot, '.beads', 'backup'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.beads', 'metadata.json'),
    JSON.stringify(metadata || { database: 'dolt', dolt_database: databaseName }, null, 2),
  );
  fs.writeFileSync(path.join(repoRoot, '.beads', 'backup', 'issues.jsonl'), '{"id":"forge-1"}\n');

  fs.writeFileSync(bdScript, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  if [[ -f ${JSON.stringify(toBashPath(restoredFlag))} ]]; then
    echo "[]"
    exit 0
  fi
  echo "database repo-root not found" >&2
  exit 1
fi
if [[ "$1" == "init" ]]; then
  printf '%s' "$*" > ${JSON.stringify(toBashPath(capturePath))}
  exit 0
fi
if [[ "$1" == "backup" && "$2" == "restore" ]]; then
  touch ${JSON.stringify(toBashPath(restoredFlag))}
  exit 0
fi
if [[ "$1" == "children" ]]; then
  echo "[]"
  exit 0
fi
echo "[]" 
`, { mode: 0o755 });

  fs.writeFileSync(gitScript, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then
  printf '%s\\n' ${JSON.stringify(toBashPath(repoRoot))}
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 1
`, { mode: 0o755 });

  return { tmpDir, bdScript, gitScript, capturePath };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

module.exports = {
  BASH_PATH_ENV,
  PROJECT_ROOT,
  SCRIPT,
  cleanupTmpDir,
  createCrLfJqWrapper,
  createMetadataRecoveryMocks,
  createMockBd,
  daysAgo,
  normalizeBashEnv,
  parseIssues,
  resolveBashCommand,
  resolveBashPathEnv,
  runSmartStatus,
  toBashPath,
};
