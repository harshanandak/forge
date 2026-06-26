'use strict';

// E2E: project memory persists to the KERNEL store by default — no Beads, no
// FORGE_ISSUE_BACKEND. Mirrors kernel-default-cli.test.js: a throwaway git repo with a
// scrubbed env, exercising the real lib/project-memory write/read path in a child
// process (so the SQLite connection closes on exit). The data must land in a fresh
// `.git/forge/kernel.sqlite` and round-trip, and NO `.beads` store may be created —
// proof the path never shells out to the old Beads command runner.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_MEMORY = path.join(__dirname, '..', '..', 'lib', 'project-memory.js');
const TIMEOUT = 30000;

// Windows can hold a transient WAL lock on the just-written DB; retry the rm.
function rmrfWithRetry(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || (error.code !== 'EBUSY' && error.code !== 'EPERM')) {
        return; // best-effort cleanup; never fail a test on a temp-dir lock
      }
      const until = Date.now() + 100;
      while (Date.now() < until) { /* brief spin before retry */ }
    }
  }
}

// Run the real project-memory facade in a child process rooted at the temp repo. A
// scrubbed env strips any ambient FORGE_ISSUE_BACKEND so the run exercises the pure
// default kernel path. The child writes then reads back one entry and prints it.
function runMemoryRoundTrip(cwd) {
  const env = { ...process.env };
  delete env.FORGE_ISSUE_BACKEND;
  const script = `
    const pm = require(${JSON.stringify(PROJECT_MEMORY)});
    const root = process.cwd();
    pm.write(root, {
      key: 'e2e.kernel',
      value: { hello: 'kernel' },
      sourceAgent: 'e2e',
      tags: ['e2e'],
    });
    process.stdout.write(JSON.stringify(pm.read(root, 'e2e.kernel')));
  `;
  try {
    const stdout = execFileSync('node', ['-e', script], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { stdout, status: 0 };
  } catch (error) {
    return {
      stdout: `${error.stdout || ''}${error.stderr || ''}`,
      status: typeof error.status === 'number' ? error.status : 1,
    };
  }
}

describe('project memory persists to the kernel store by default (no Beads)', () => {
  let repo;
  let dbPath;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-memory-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    dbPath = path.join(repo, '.git', 'forge', 'kernel.sqlite');
  });

  afterEach(() => {
    rmrfWithRetry(repo);
  });

  test(
    'write/read round-trips through .git/forge/kernel.sqlite and creates no Beads store',
    () => {
      expect(fs.existsSync(dbPath)).toBe(false);

      const { stdout, status } = runMemoryRoundTrip(repo);
      expect(status).toBe(0);

      // The entry round-trips through the kernel read model.
      const entry = JSON.parse(stdout);
      expect(entry).toMatchObject({
        key: 'e2e.kernel',
        value: { hello: 'kernel' },
        sourceAgent: 'e2e',
        tags: ['e2e'],
      });

      // The kernel DB was materialized by the default path — proof of routing.
      expect(fs.existsSync(dbPath)).toBe(true);
      // The legacy Beads store is never created: the path shells out to no Beads CLI.
      expect(fs.existsSync(path.join(repo, '.beads'))).toBe(false);
    },
    TIMEOUT,
  );
});
