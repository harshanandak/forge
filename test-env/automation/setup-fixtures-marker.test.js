// Test: setup-fixtures.sh completion-marker contract (issue 77037eab).
// Every run points the script at a temp tree via FORGE_FIXTURES_DIR. Forced
// runs use a fake `git` on PATH so a whole rebuild finishes in seconds.

import { afterEach, describe, expect, test } from 'bun:test';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveBashCommand } = require('../../test/helpers/bash.js');
const { ensureTestFixtures, FIXTURES_COMPLETE_MARKER, FIXTURES_DIR } = require('../helpers/fixtures.js');

const SETUP_SCRIPT = path.join(__dirname, 'setup-fixtures.sh');
const SCRIPT_TEST_TIMEOUT_MS = 30000;
// A whole forced rebuild (15 fixtures, ~170 process spawns even with a no-op
// git) measured 6 s idle and 9.3-14.9 s with six other bun suites running on a
// Windows host. 60 s is ~4x the worst run; the test gets 30 s more on top.
const FORCED_RUN_SPAWN_TIMEOUT_MS = 60000;
const FORCED_RUN_TEST_TIMEOUT_MS = FORCED_RUN_SPAWN_TIMEOUT_MS + 30000;

const FIXTURE_NAMES = [
  'fresh-project', 'existing-forge-v1', 'partial-install', 'conflicting-configs',
  'read-only-dirs', 'no-git', 'dirty-git', 'detached-head', 'merge-conflict',
  'monorepo', 'nextjs-project', 'nestjs-project', 'unicode-paths',
  'large-agents-md', 'missing-prerequisites',
];

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  tempDirs.push(dir);
  return dir;
}

// The script only honours FORGE_FIXTURES_DIR when it holds this opt-in file.
const SANDBOX_SENTINEL = '.forge-fixtures-sandbox';

function createTempFixturesDir({ sandbox = true } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-fixtures-')));
  if (sandbox) fs.writeFileSync(path.join(dir, SANDBOX_SENTINEL), '');
  return dir;
}

// Every fixture directory exists and the two late outputs the old check looked
// for are present, but no fixture carries its real artifacts (no repos, no
// MERGE_HEAD, no docker-compose.yml): what a killed run can leave behind.
function materializePartialTree(fixturesDir) {
  for (const name of FIXTURE_NAMES) {
    fs.mkdirSync(path.join(fixturesDir, name), { recursive: true });
  }
  fs.writeFileSync(path.join(fixturesDir, 'monorepo', 'pnpm-workspace.yaml'), 'packages: []\n');
  fs.writeFileSync(path.join(fixturesDir, 'large-agents-md', 'AGENTS.md'), 'x\n'.repeat(400));
}

// A `git` that is the system `true` binary: every call succeeds instantly and
// prints nothing. Every create_* step then "succeeds" (FAILED_FIXTURES stays
// empty) but dirty-git never gets uncommitted changes, so only the end-of-run
// completeness check can catch it. A native binary, not a bash script, keeps a
// whole forced rebuild to a few seconds on Windows.
function createFakeGitDir() {
  const binDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fake-git-')));
  const copyTrue = [
    'src="$(type -P true)"; ext=""',
    'case "$src" in *.exe) ext=".exe" ;; *) if [ -e "$src.exe" ]; then src="$src.exe"; ext=".exe"; fi ;; esac',
    'cp "$src" "$1/git$ext"',
  ].join('\n');
  const result = spawnSync(resolveBashCommand(), ['-c', copyTrue, '_', binDir], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not create fake git: ${result.stderr}`);
  return binDir;
}

// Git for Windows' bash.exe wrapper puts its own bin dirs first on PATH, so the
// fake git is prepended inside bash, right before exec'ing the script. The
// command text is fixed; the fake-git dir and the script arrive as positional
// arguments, so no path is ever spliced into the shell string.
const WITH_FAKE_GIT = [
  'dir="$1"',
  'shift',
  'if command -v cygpath > /dev/null 2>&1; then dir="$(cygpath -u "$dir")"; fi',
  'PATH="$dir:$PATH"',
  'export PATH',
  'exec bash "$@"',
].join('\n');

function runSetup(fixturesDir, args, { fakeGit = false, timeoutMs = 20000 } = {}) {
  const env = { ...process.env, FORGE_FIXTURES_DIR: fixturesDir };
  // These runs build fixtures; never let the runner's reader-only flag leak in.
  delete env.FORGE_FIXTURES_PREPARED;
  const bashArgs = fakeGit
    ? ['-c', WITH_FAKE_GIT, '_', createFakeGitDir(), SETUP_SCRIPT, ...args]
    : [SETUP_SCRIPT, ...args];
  const result = spawnSync(resolveBashCommand(), bashArgs, {
    cwd: __dirname,
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

const markerPath = (fixturesDir) => path.join(fixturesDir, FIXTURES_COMPLETE_MARKER);

// A certified tree to mutate: a sandboxed copy of the real fixture tree, which
// ensureTestFixtures guarantees is complete and carries the marker.
function createCertifiedSandbox() {
  ensureTestFixtures();
  const sandbox = createTempFixturesDir();
  fs.cpSync(FIXTURES_DIR, sandbox, { recursive: true });
  fs.rmSync(path.join(sandbox, '.setup-lock'), { recursive: true, force: true });
  return sandbox;
}

describe('setup-fixtures.sh completion marker', () => {
  test('a non-force run over a partial tree never publishes the marker', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);

    runSetup(fixturesDir, ['--no-validate']);

    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a non-force run removes a marker whose tree no longer passes the checks', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);
    fs.writeFileSync(markerPath(fixturesDir), '');

    const result = runSetup(fixturesDir, ['--no-validate']);

    expect(result.output).toContain('Removing stale fixture completion marker: fresh-project: repo');
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a non-force run invalidates a certified tree that lost a late artifact', () => {
    const fixturesDir = createCertifiedSandbox();
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(true);
    expect(runSetup(fixturesDir, ['--check']).status).toBe(0);
    fs.rmSync(path.join(fixturesDir, 'monorepo', 'pnpm-workspace.yaml'));

    const result = runSetup(fixturesDir, ['--no-validate']);

    expect(result.output).toContain('Removing stale fixture completion marker: monorepo: pnpm-workspace.yaml');
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a non-force run keeps the marker on a certified tree that still passes', () => {
    const fixturesDir = createCertifiedSandbox();

    const result = runSetup(fixturesDir, ['--no-validate']);

    expect(result.status).toBe(0);
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(true);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a --force run that cannot remove the old marker stops before touching any fixture', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);
    fs.writeFileSync(path.join(fixturesDir, 'fresh-project', 'keep.txt'), 'keep');
    // A directory in the marker's place makes `rm -f` fail deterministically.
    fs.mkdirSync(markerPath(fixturesDir));
    fs.writeFileSync(path.join(markerPath(fixturesDir), 'blocker'), '');

    const result = runSetup(fixturesDir, ['--force', '--no-validate'], { fakeGit: true });

    expect(result.status).toBe(1);
    expect(result.output).toContain('Failed to remove fixture completion marker');
    expect(fs.existsSync(path.join(fixturesDir, 'fresh-project', 'keep.txt'))).toBe(true);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('--check rejects a tree whose fixtures lack their key artifacts', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);

    const result = runSetup(fixturesDir, ['--check']);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Fixture tree incomplete: fresh-project');
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a --force run whose rebuilt tree fails the completeness check exits non-zero', () => {
    const fixturesDir = createTempFixturesDir();

    const result = runSetup(fixturesDir, ['--force', '--no-validate'], {
      fakeGit: true,
      timeoutMs: FORCED_RUN_SPAWN_TIMEOUT_MS,
    });

    expect(result.output).toContain('Fixture tree incomplete: dirty-git: dirty');
    expect(result.output).toContain('completeness check (dirty-git: dirty)');
    expect(result.status).toBe(1);
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
  }, FORCED_RUN_TEST_TIMEOUT_MS);
});

describe('setup-fixtures.sh FORGE_FIXTURES_DIR guard', () => {
  const REFUSAL = `FORGE_FIXTURES_DIR must be an existing directory containing ${SANDBOX_SENTINEL}`;

  test('refuses a fixtures dir without the sandbox sentinel before touching anything', () => {
    const unmarked = createTempFixturesDir({ sandbox: false });
    fs.mkdirSync(path.join(unmarked, 'fresh-project'));
    fs.writeFileSync(path.join(unmarked, 'fresh-project', 'keep.txt'), 'keep');

    const result = runSetup(unmarked, ['--force', '--no-validate'], { fakeGit: true });

    expect(result.status).toBe(1);
    expect(result.output).toContain(REFUSAL);
    expect(fs.existsSync(path.join(unmarked, 'fresh-project', 'keep.txt'))).toBe(true);
    expect(fs.readdirSync(unmarked)).toEqual(['fresh-project']);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('refuses a fixtures dir that does not exist', () => {
    const parent = createTempFixturesDir({ sandbox: false });
    const missing = path.join(parent, 'missing');

    const result = runSetup(missing, ['--force', '--no-validate'], { fakeGit: true });

    expect(result.status).toBe(1);
    expect(result.output).toContain(REFUSAL);
    expect(fs.existsSync(missing)).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);
});
