// Test: setup-fixtures.sh completion-marker and lock contract (issue 77037eab).
// Every run points the script at a temp tree via FORGE_FIXTURES_DIR and only
// exercises paths that finish in seconds (no full fixture creation).

import { afterEach, describe, expect, test } from 'bun:test';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveBashCommand } = require('../../test/helpers/bash.js');
const { FIXTURES_COMPLETE_MARKER } = require('../helpers/fixtures.js');

const SETUP_SCRIPT = path.join(__dirname, 'setup-fixtures.sh');
const SCRIPT_TEST_TIMEOUT_MS = 30000;

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

function createTempFixturesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-fixtures-'));
  tempDirs.push(dir);
  return dir;
}

// Every fixture directory exists and the two late outputs the old check looked
// for are present, but no fixture carries its real artifacts (no repos, no
// MERGE_HEAD, no docker-compose.yml): what a killed run can leave behind.
function materializePartialTree(fixturesDir, { omit = [] } = {}) {
  for (const name of FIXTURE_NAMES) {
    if (!omit.includes(name)) fs.mkdirSync(path.join(fixturesDir, name), { recursive: true });
  }
  if (!omit.includes('monorepo')) {
    fs.writeFileSync(path.join(fixturesDir, 'monorepo', 'pnpm-workspace.yaml'), 'packages: []\n');
  }
  if (!omit.includes('large-agents-md')) {
    fs.writeFileSync(path.join(fixturesDir, 'large-agents-md', 'AGENTS.md'), 'x\n'.repeat(400));
  }
}

function runSetup(fixturesDir, args, extraEnv = {}) {
  const env = { ...process.env };
  delete env.FORGE_FIXTURE_LOCK_HELD;
  Object.assign(env, { FORGE_FIXTURES_DIR: fixturesDir }, extraEnv);
  const result = spawnSync(resolveBashCommand(), [SETUP_SCRIPT, ...args], {
    cwd: __dirname,
    encoding: 'utf8',
    env,
    timeout: 20000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

const markerPath = (fixturesDir) => path.join(fixturesDir, FIXTURES_COMPLETE_MARKER);
const lockPath = (fixturesDir) => path.join(fixturesDir, '.setup-lock');

describe('setup-fixtures.sh completion marker', () => {
  test('a non-force run over a partial tree never publishes the marker', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);

    runSetup(fixturesDir, ['--no-validate']);

    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a non-force run never deletes an existing marker', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);
    fs.writeFileSync(markerPath(fixturesDir), '');

    runSetup(fixturesDir, ['--no-validate']);

    expect(fs.existsSync(markerPath(fixturesDir))).toBe(true);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('--check rejects a tree whose fixtures lack their key artifacts', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);

    const result = runSetup(fixturesDir, ['--check']);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Fixture tree incomplete: fresh-project');
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);
});

describe('setup-fixtures.sh setup lock', () => {
  test('a --force run fails fast while the setup lock is held and mutates nothing', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);
    fs.writeFileSync(path.join(fixturesDir, 'fresh-project', 'keep.txt'), 'keep');
    fs.mkdirSync(lockPath(fixturesDir));

    const result = runSetup(fixturesDir, ['--force', '--no-validate']);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Fixture setup lock is held');
    expect(fs.existsSync(path.join(fixturesDir, 'fresh-project', 'keep.txt'))).toBe(true);
    expect(fs.existsSync(markerPath(fixturesDir))).toBe(false);
    expect(fs.existsSync(lockPath(fixturesDir))).toBe(true);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a non-force run that would create a missing fixture takes the lock', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir, { omit: ['no-git'] });
    fs.mkdirSync(lockPath(fixturesDir));

    const result = runSetup(fixturesDir, ['--no-validate']);

    expect(result.status).toBe(1);
    expect(result.output).toContain('Fixture setup lock is held');
    expect(fs.existsSync(path.join(fixturesDir, 'no-git'))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a run that takes the lock releases it on exit', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir, { omit: ['no-git'] });

    const result = runSetup(fixturesDir, ['--no-validate']);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(fixturesDir, 'no-git', 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(lockPath(fixturesDir))).toBe(false);
  }, SCRIPT_TEST_TIMEOUT_MS);

  test('a non-force run over a complete set of directories needs no lock', () => {
    const fixturesDir = createTempFixturesDir();
    materializePartialTree(fixturesDir);
    fs.mkdirSync(lockPath(fixturesDir));

    const result = runSetup(fixturesDir, ['--no-validate']);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Fixture already exists/);
  }, SCRIPT_TEST_TIMEOUT_MS);
});
