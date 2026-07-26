'use strict';

/**
 * Shared isolation harness for tests that spawn the real forge CLI as a child
 * process.
 *
 * Why this exists: `bin/forge.js` resolves its project root as
 * `process.env.INIT_CWD || process.cwd()` (bin/forge.js:106) and then reads and
 * WRITES state under `<projectRoot>/.forge/`. A CLI test that spawns the binary
 * with the repo checkout as its cwd therefore shares that state with every other
 * test — and `scripts/test-full-suite.js` runs its shards concurrently
 * (Promise.all over spawnShard), so several `bun test` processes hit the same
 * checkout at once. That produced fast, wrong answers rather than timeouts.
 *
 * Every spawn here gets a private sandbox directory as BOTH cwd and INIT_CWD,
 * and a scrubbed environment, so it inherits nothing from the repo checkout or a
 * sibling test.
 *
 * @module test/helpers/cli-subprocess
 */

const { execFileSync } = require('node:child_process');
const { setDefaultTimeout } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rmrfWithRetry } = require('./kernel-project-root');

const FORGE_BIN = path.join(__dirname, '..', '..', 'bin', 'forge.js');

// A cold `node bin/forge.js` costs ~1s idle, but the local full suite runs its
// shards concurrently, and spawns were measured finishing at 10.1-10.6s under
// that load — so the old 10s inner limit sat below the noise floor rather than
// bounding a real hang. 30s inner / 45s case keeps a genuine hang bounded while
// leaving the inner limit strictly lower, so a timeout surfaces as a timeout.
const CLI_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 45_000;

// Sandbox setup shells out to git; bound it well under the spawn budget so a
// wedged `git init` reports as itself rather than eating the CLI's time.
const GIT_INIT_TIMEOUT_MS = 10_000;

// The inner spawn limit is only meaningful if the case outlives it — otherwise
// bun kills the case first and the diagnostic thrown below never runs. Suites
// invoke bun with --timeout 15000 (scripts/test-ci-shard.js) or 30000
// (scripts/test-full-suite.js), both <= CLI_TIMEOUT_MS, so raising the case
// timeout is not optional bookkeeping a suite can forget. Doing it here at
// import time makes the invariant structural: importing this harness IS opting
// into the matching case budget.
if (CLI_TIMEOUT_MS >= CASE_TIMEOUT_MS) {
  throw new Error(
    `cli-subprocess: inner CLI timeout (${CLI_TIMEOUT_MS}ms) must be strictly `
    + `lower than the case timeout (${CASE_TIMEOUT_MS}ms)`
  );
}
setDefaultTimeout(CASE_TIMEOUT_MS);

/**
 * Build the base child environment: the ambient env minus anything that would
 * silently repoint the CLI at state this test does not own. `INIT_CWD` is the
 * critical one — bin/forge.js prefers it over cwd, so an inherited value sends
 * the child at the ambient repo no matter which cwd we pass.
 *
 * @returns {Record<string, string>} Scrubbed environment
 */
function baseEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('FORGE_')) delete env[key];
  }
  delete env.INIT_CWD;
  return env;
}

/**
 * Merge the child environment, collapsing PATH to exactly one key.
 *
 * Windows resolves environment names case-insensitively, but a JS object does
 * not: spreading `process.env` yields `Path`, so an override that sets `PATH`
 * leaves BOTH keys in the object and which one the child actually reads is
 * platform-dependent. Callers overriding PATH (to hide a binary, or to plant a
 * fake one) would silently get the real ambient PATH instead.
 *
 * @param {string} cwd - Sandbox directory, also used as INIT_CWD
 * @param {Record<string, string>} envOverrides - Caller overrides, applied last
 * @returns {Record<string, string>} Merged env with a single PATH key
 */
function mergeEnv(cwd, envOverrides) {
  const merged = { ...baseEnv(), INIT_CWD: cwd, ...envOverrides };

  const isPathKey = (key) => /^path$/i.test(key);
  const pathKeys = Object.keys(merged).filter(isPathKey);
  if (pathKeys.length > 0) {
    // An explicit override wins over whatever casing the ambient env used.
    const overrideKey = Object.keys(envOverrides).find(isPathKey);
    const value = overrideKey === undefined ? merged[pathKeys[0]] : envOverrides[overrideKey];
    for (const key of pathKeys) delete merged[key];
    merged[process.platform === 'win32' ? 'Path' : 'PATH'] = value;
  }

  return merged;
}

/**
 * Per-suite factory of private CLI sandboxes. Each sandbox is a throwaway git
 * repo containing only `AGENTS.md` (which satisfies the first-run check in
 * bin/forge.js). `.forge/` is deliberately NOT pre-created: the CLI's own lazy
 * home creation then lands inside the sandbox, which is exactly the state we
 * want it to own.
 *
 * The `git init` is not cosmetic — forge's runtime health and worktree detection
 * shell out to git, and in a non-repo directory `forge verify` blocks for over
 * 30s instead of reporting anything (kernel issue 15587fd6).
 *
 * @param {string} prefix - mkdtemp prefix, so leaked dirs are attributable
 * @returns {{ makeSandbox: () => string, cleanup: () => void }}
 */
function createCliSandboxes(prefix) {
  const dirs = [];

  function makeSandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Test project\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: dir, timeout: GIT_INIT_TIMEOUT_MS });
    return dir;
  }

  function cleanup() {
    while (dirs.length > 0) {
      rmrfWithRetry(dirs.pop());
    }
  }

  return { makeSandbox, cleanup };
}

/**
 * Run the forge CLI inside a sandbox directory and capture its result.
 *
 * A timeout THROWS rather than returning `status: 1`. A timed-out spawn produced
 * no answer at all, and reporting it as an ordinary non-zero exit is what made
 * these failures read as assertion mismatches instead of scheduling pressure.
 *
 * @param {string} cwd - Sandbox directory from {@link createCliSandboxes}
 * @param {string[]} cliArgs - Arguments to pass to forge
 * @param {object} [options]
 * @param {Record<string, string>} [options.env] - Env overrides applied last
 * @param {number} [options.timeoutMs] - Inner spawn timeout
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function runForgeIn(cwd, cliArgs, { env: envOverrides = {}, timeoutMs = CLI_TIMEOUT_MS } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [FORGE_BIN, ...cliArgs], {
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd,
      env: mergeEnv(cwd, envOverrides),
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    if (err.killed || err.signal) {
      throw new Error(
        `forge ${cliArgs.join(' ')} did not finish within ${timeoutMs}ms `
        + `(killed by ${err.signal || 'timeout'}). stdout=${JSON.stringify(err.stdout || '')} `
        + `stderr=${JSON.stringify(err.stderr || '')}`
      );
    }
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      status: err.status ?? 1,
    };
  }
}

module.exports = {
  CASE_TIMEOUT_MS,
  CLI_TIMEOUT_MS,
  GIT_INIT_TIMEOUT_MS,
  FORGE_BIN,
  baseEnv,
  createCliSandboxes,
  mergeEnv,
  runForgeIn,
};
