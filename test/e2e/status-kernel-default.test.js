'use strict';

// E2E revert-red guard for bug 40f35797: `forge status` (zero-arg, the flagship
// one-glance view) must build its snapshot from the KERNEL — the default backend —
// not the retired Beads store (.beads/issues.jsonl), which is empty on a
// kernel-default repo. Pre-fix, status.js was hard-wired to readBeadsSnapshot, so a
// repo whose kernel held a full backlog still rendered "Ready: none" and the
// dead-end "/plan" next-step.
//
// This spawns the REAL `forge` bin end to end (create -> status) against a throwaway
// git repo with NO backend selector, so it exercises the exact handler wiring in
// lib/commands/status.js. Reverting the readBeadsSnapshot -> readStatusSnapshot swap
// turns this RED: the spawned `forge status` would read the empty Beads jsonl and
// print "Ready: none" instead of the kernel's "Ready: 2 more" + claim fallback. The
// unit test in test/status/snapshot.test.js proves the snapshot mechanism; this one
// guards the source wiring that WAS the bug.

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FORGE_BIN = path.join(__dirname, '..', '..', 'bin', 'forge.js');
const TIMEOUT = 30000;

// Spawn the real forge bin with NO backend selector; a scrubbed env strips any
// ambient FORGE_ISSUE_BACKEND so the run exercises the pure default (kernel) path.
function runForgeDefault(cwd, args) {
  const env = { ...process.env };
  delete env.FORGE_ISSUE_BACKEND;
  try {
    const stdout = execFileSync('node', [FORGE_BIN, ...args], {
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

// Pull the minted UUID id out of a `forge create` kernel contract envelope.
function extractId(stdout) {
  const match = stdout.match(/"id":\s*"([^"]+)"/);
  return match ? match[1] : null;
}

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

describe('forge status (zero-arg) reads the kernel by default — bug 40f35797', () => {
  let repo;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-default-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // AGENTS.md bypasses the first-run setup gate (mirrors kernel-default-cli.test.js).
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# test\n');
  });

  afterEach(() => {
    rmrfWithRetry(repo);
  });

  test(
    'the one-glance view surfaces the kernel ready backlog, not the empty Beads store',
    () => {
      // Seed two ready issues on the kernel default path (no --kernel flag).
      const idA = extractId(runForgeDefault(repo, ['create', '--title', 'Kernel ready one', '--type', 'task']).stdout);
      const idB = extractId(runForgeDefault(repo, ['create', '--title', 'Kernel ready two', '--type', 'task']).stdout);
      expect(idA && idB).toBeTruthy();

      const { stdout, status } = runForgeDefault(repo, ['status']);
      expect(status).toBe(0);

      // Fix behavior: the kernel's 2 ready issues drive the count + a claim fallback.
      // On a revert to readBeadsSnapshot the empty .beads store would render
      // "Ready: none" and the "/plan" dead-end, turning both assertions RED.
      expect(stdout).toContain('Ready: 2 more');
      expect(stdout).toContain('forge claim ');
      // The claim fallback points at a real, freshly-created kernel issue id.
      expect(stdout.includes(idA) || stdout.includes(idB)).toBe(true);

      // Never the empty-state signals the bug produced.
      expect(stdout).not.toContain('Ready: none');
      expect(stdout).not.toContain('no ready issues. Next: /plan');
    },
    TIMEOUT,
  );
});
