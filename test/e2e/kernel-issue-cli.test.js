'use strict';

// E2E: the kernel CLI close path end to end (T7). Spawns the real `forge` bin
// against a throwaway git repo so a fresh `.git/forge/kernel.sqlite` is created,
// seeds 3 open issues via `forge create --kernel`, then closes all three with one
// `forge close <ids> --reason --kernel` invocation. Mirrors the real
// kap-10/11/12 close, but on synthetic ids we control (stronger + repeatable).

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FORGE_BIN = path.join(__dirname, '..', '..', 'bin', 'forge.js');
const TIMEOUT = 30000;

function runForge(cwd, args) {
  return execFileSync('node', [FORGE_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

// Open one read driver, run a reader against it, and ALWAYS close it so the
// SQLite (WAL) file lock is released before Windows tries to rm the temp dir.
// The real builtin SQLite runtime is selected (not a fake): these helpers read
// the SAME authority tables / event log the spawned `forge` bin just wrote, so a
// green assertion proves the persisted on-disk state, not an in-memory echo.
async function withReadDriver(dbPath, fn) {
  const {
    createBuiltinSQLiteDriver,
    selectBuiltinSQLiteRuntime,
  } = require('../../lib/kernel/sqlite-driver');
  const driver = createBuiltinSQLiteDriver({
    databasePath: dbPath,
    runtime: selectBuiltinSQLiteRuntime({}),
  });
  try {
    return await fn(driver, { databasePath: dbPath });
  } finally {
    if (typeof driver.close === 'function') driver.close();
  }
}

// Read the persisted issue row (authority table) via the driver's `show` read-op.
// Returns a normalized `{ status }` (or null when the id is absent), so the close
// assertion reads the SAME read-model the rest of Forge reads. The close event
// drives status to the terminal 'done'.
async function loadIssueStatus(dbPath, id) {
  return withReadDriver(dbPath, async (driver) => {
    const response = await driver.issueOperation('show', [id], {}, {});
    if (!response || response.ok === false || !response.data) return null;
    return { status: response.data.status };
  });
}

// Read the immutable `issue.close` event for an id from the event log. The CLI
// `--reason` has no column on kernel_issues (the read-model whitelist drops it),
// so its event-sourced home is kernel_events.payload_json — this is where the
// close annotation must be asserted. Returns the raw event row (carrying
// `payload_json`) or null when no close event exists.
async function loadCloseEvent(dbPath, id) {
  return withReadDriver(dbPath, async (driver) => {
    const events = await driver.listKernelEvents('issue', id, {}, {});
    return events.find(event => event.event_type === 'issue.close') || null;
  });
}

// Windows can hold a transient lock on the just-closed DB; retry the rm a few times.
function rmrfWithRetry(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || (error.code !== 'EBUSY' && error.code !== 'EPERM')) {
        return; // best-effort cleanup; do not fail the test on a temp-dir lock
      }
      const until = Date.now() + 100;
      while (Date.now() < until) { /* brief spin before retry */ }
    }
  }
}

describe('kernel issue CLI — multi-id close E2E', () => {
  let repo;
  let dbPath;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // AGENTS.md bypasses the first-run setup gate.
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# test\n');
    dbPath = path.join(repo, '.git', 'forge', 'kernel.sqlite');
  });

  afterEach(() => {
    // Driver is closed by withReadDriver before the test returns, but Windows can
    // still hold a transient WAL lock — retry the rm so cleanup never flakes.
    rmrfWithRetry(repo);
  });

  test(
    'forge close <3 ids> --reason --kernel closes all three, exit 0, reason persisted',
    async () => {
      // Seed three open issues on the fresh kernel DB.
      for (const id of ['kap-10', 'kap-11', 'kap-12']) {
        runForge(repo, ['create', '--id', id, '--title', `Seed ${id}`, '--kernel']);
      }

      // The acceptance invocation.
      const output = runForge(repo, [
        'close',
        'kap-10',
        'kap-11',
        'kap-12',
        '--reason=Merged and verified on master (PR #229)',
        '--kernel',
      ]);

      // All three reported back (one envelope per id).
      expect(output).toContain('kap-10');
      expect(output).toContain('kap-11');
      expect(output).toContain('kap-12');

      // Authority table: all three are terminal.
      for (const id of ['kap-10', 'kap-11', 'kap-12']) {
        const issue = await loadIssueStatus(dbPath, id);
        expect(issue).toBeTruthy();
        expect(issue.status).toBe('done');
      }

      // Reason persisted in the immutable event log for each close.
      for (const id of ['kap-10', 'kap-11', 'kap-12']) {
        const closeEvent = await loadCloseEvent(dbPath, id);
        expect(closeEvent).toBeTruthy();
        const payload = JSON.parse(closeEvent.payload_json);
        expect(payload.reason).toBe('Merged and verified on master (PR #229)');
      }
    },
    TIMEOUT,
  );

  test(
    'exit code is 0 for the multi-id kernel close',
    () => {
      runForge(repo, ['create', '--id', 'solo-1', '--title', 'Solo 1', '--kernel']);
      runForge(repo, ['create', '--id', 'solo-2', '--title', 'Solo 2', '--kernel']);
      // execFileSync throws on non-zero exit; reaching the assertion means exit 0.
      // Two leading ids exercises the batched (fan-out) close branch, not the
      // single-id path.
      const output = runForge(repo, ['close', 'solo-1', 'solo-2', '--reason=done', '--kernel']);
      expect(output).toContain('solo-1');
      expect(output).toContain('solo-2');
    },
    TIMEOUT,
  );

  test(
    'a not-found close on --json prints the forge.issue.error.v1 envelope and exits 3',
    () => {
      // BUG A parity: a failed kernel issue command must emit the structured error
      // envelope on stdout (under --json) and exit with the contract exit_code for
      // the error class (not-found = 3), NOT collapse every failure to exit 1.
      let thrown;
      try {
        runForge(repo, ['close', 'no-such-id', '--json', '--kernel']);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown.status).toBe(3);

      const envelope = JSON.parse(thrown.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.schema_version).toBe('forge.issue.error.v1');
      expect(envelope.command).toBe('issue.close');
      expect(envelope.error.code).toBe('FORGE_ISSUE_NOT_FOUND');
      expect(envelope.error.exit_code).toBe(3);
    },
    TIMEOUT,
  );
});
