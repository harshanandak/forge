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
    ...(env.FORGE_CMD ? { FORGE_CMD: toBashPath(env.FORGE_CMD) } : {}),
    ...(env.GIT_CMD ? { GIT_CMD: toBashPath(env.GIT_CMD) } : {}),
    ...(env.JQ_CMD ? { JQ_CMD: toBashPath(env.JQ_CMD) } : {}),
    ...(env.REAL_GIT ? { REAL_GIT: toBashPath(env.REAL_GIT) } : {}),
  };
}

function runSmartStatus(args = [], env = {}, stdin = undefined) {
  const mergedEnv = {
    ...process.env,
    PATH: BASH_PATH_ENV,
    Path: BASH_PATH_ENV,
    GIT_CMD: 'true',
    ...normalizeBashEnv(env),
  };

  if (process.platform === 'win32' && Object.prototype.hasOwnProperty.call(env, 'PATH')) {
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
  if (!parsed || !Array.isArray(parsed.issues)) {
    throw new Error('Expected {sessions, issues} envelope but got: ' + stdout.slice(0, 200));
  }
  return parsed.issues;
}

// Convert a bd-shaped fixture issue into the Forge Kernel `issue.list` shape:
// `closed` -> `done`; dependency/dependent COUNTS -> id ARRAYS (the kernel
// supplies dependents/dependencies as arrays, not counts). Synthetic ids are
// fine — the scorer + grouping read only array lengths, and the "Unblocks"
// display asserts presence, not specific ids. An explicit `dependencies` array
// of `{ depends_on_id }` objects is flattened to the kernel id-string form.
function toKernelIssue(issue) {
  const out = { ...issue };
  if (out.status === 'closed') {
    out.status = 'done';
  }
  if (Array.isArray(out.dependencies)) {
    out.dependencies = out.dependencies.map((d) => (typeof d === 'string' ? d : d.depends_on_id));
  } else if (typeof out.dependency_count === 'number') {
    out.dependencies = Array.from({ length: out.dependency_count }, (_, i) => `__dep_${out.id}_${i}`);
  } else {
    out.dependencies = [];
  }
  if (!Array.isArray(out.dependents) && typeof out.dependent_count === 'number') {
    out.dependents = Array.from({ length: out.dependent_count }, (_, i) => `__dependent_${out.id}_${i}`);
  } else if (!Array.isArray(out.dependents)) {
    out.dependents = [];
  }
  delete out.dependent_count;
  delete out.dependency_count;
  return out;
}

// Build a `forge` mock that answers both the issue-list fetch and the epic-child
// rollup the de-beaded smart-status.sh relies on:
//   - `forge issue list --json`        -> the kernel issue.list envelope
//   - `forge issue children <id> --json` -> the kernel issue.children envelope
// smart-status reads only .data.rollup.total + .data.rollup.done from children,
// and the kernel `done` status replaces the legacy beads `closed`.
function createMockForge(jsonData) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-status-test-'));
  const listEnvelope = {
    schema_version: 'forge.issue.v1',
    command: 'issue.list',
    data: { issues: (jsonData.issues || []).map(toKernelIssue) },
  };

  const forgeScript = path.join(tmpDir, 'forge');
  const forgeCases = (jsonData.epicChildren || []).map((ec) => {
    const kids = ec.children || [];
    // The real issue.children rollup excludes cancelled children from
    // total/percentage; mirror that here so a cancelled-child fixture exercises
    // the payload production actually emits (and can't hide scoring bugs).
    const activeKids = kids.filter((k) => k.status !== 'cancelled');
    const total = activeKids.length;
    const done = activeKids.filter((k) => k.status === 'closed' || k.status === 'done').length;
    const inProgress = activeKids.filter((k) => k.status === 'in_progress').length;
    const review = activeKids.filter((k) => k.status === 'review').length;
    const open = activeKids.filter((k) => k.status === 'open').length;
    const cancelled = kids.length - activeKids.length;
    const envelope = {
      schema_version: 'forge.issue.v1',
      command: 'issue.children',
      data: {
        epic: { id: ec.id, title: ec.id, type: 'epic', status: 'open' },
        children: kids.map((k) => ({ id: k.id, status: k.status === 'closed' ? 'done' : k.status })),
        rollup: {
          total,
          done,
          in_progress: inProgress,
          open,
          review,
          cancelled,
          blocked: 0,
          percentage: total === 0 ? 0 : Math.round((done / total) * 100),
          by_status: {},
        },
        count: total,
      },
      next_commands: [],
    };
    return `    "${ec.id}") cat <<'JSONEOF'\n${JSON.stringify(envelope)}\nJSONEOF\n    ;;`;
  }).join('\n');
  const emptyEnvelope = '{"schema_version":"forge.issue.v1","command":"issue.children","data":{"epic":null,"children":[],"rollup":{"total":0,"done":0,"in_progress":0,"open":0,"review":0,"cancelled":0,"blocked":0,"percentage":0,"by_status":{}},"count":0},"next_commands":[]}';
  const forgeContent = `#!/usr/bin/env bash
if [[ "$1" == "issue" && "$2" == "list" && "$3" == "--json" ]]; then
  cat <<'JSONEOF'
${JSON.stringify(listEnvelope)}
JSONEOF
  exit 0
fi
if [[ "$1" == "issue" && "$2" == "list" ]]; then
  echo "mock forge: expected 'issue list --json', got: $*" >&2
  exit 2
fi
if [[ "$1" == "issue" && "$2" == "children" ]]; then
  EPIC_ID="$3"
  case "$EPIC_ID" in
${forgeCases}
    *) echo '${emptyEnvelope}' ;;
  esac
fi
`;
  fs.writeFileSync(forgeScript, forgeContent, { mode: 0o755 });

  return { tmpDir, forgeScript };
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
  createMockForge,
  daysAgo,
  normalizeBashEnv,
  parseIssues,
  resolveBashCommand,
  resolveBashPathEnv,
  runSmartStatus,
  toBashPath,
};
