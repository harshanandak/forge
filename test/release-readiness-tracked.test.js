'use strict';

const { afterEach, describe, test, expect } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { auditBdCallSites } = require('../lib/release-readiness');

const tempDirs = [];

// A throwaway git repo with one committed, bd-referencing file under `docs/`.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bd-audit-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'tracked.md'), 'legacy note: run `bd list` to see issues\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'seed'],
    { cwd: dir },
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('auditBdCallSites is deterministic under working-tree pollution (1d4077d8)', () => {
  test('ignores untracked files dropped under a scan root', () => {
    const repo = makeRepo();

    const clean = auditBdCallSites(repo, { scanRoots: ['docs'] });
    expect(clean.totalCount).toBeGreaterThan(0); // the committed file IS audited

    // Simulate a concurrent test dropping an untracked, bd-referencing file under the same
    // scan root. Pre-fix the raw fs walk counted it (census drifts → flaky "stale artifact");
    // the tracked-only audit must ignore it.
    fs.writeFileSync(path.join(repo, 'docs', 'pollution.md'), 'stray `bd create` call site\n');
    const polluted = auditBdCallSites(repo, { scanRoots: ['docs'] });

    expect(polluted.totalCount).toBe(clean.totalCount);
    expect(polluted.totalFiles).toBe(clean.totalFiles);
  });

  test('falls back to the raw walk in a non-git tree (no tracked set)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bd-nogit-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'note.md'), 'run `bd list`\n');
    // Not a git repo -> trackedRepoFiles() returns null -> auditBdCallSites still scans.
    const audit = auditBdCallSites(dir, { scanRoots: ['docs'] });
    expect(audit.totalCount).toBeGreaterThan(0);
  });
});
