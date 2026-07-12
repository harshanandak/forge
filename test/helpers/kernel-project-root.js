'use strict';

const { execFileSync: defaultExecFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Retire a temp dir, tolerating the Windows EBUSY/EPERM lag right after a SQLite
// handle closes (retry a few times with a brief spin, then give up quietly).
function rmrfWithRetry(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || (error.code !== 'EBUSY' && error.code !== 'EPERM')) return;
      const until = Date.now() + 100;
      while (Date.now() < until) { /* brief spin before retry */ }
    }
  }
}

// Per-suite factory: each test file gets its own tracked list of throwaway git-repo
// project roots (the kernel store path resolves from the git common dir), plus a
// cleanup that drains them. `prefix` names the tmp dirs so leaks are attributable.
function createKernelProjectRoots(prefix, deps = {}) {
  const tempDirs = [];
  const execFileSync = deps.execFileSync || defaultExecFileSync;

  function makeProjectRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    // Track for cleanup BEFORE the git call. mkdtempSync has already created the
    // dir on disk, so if `git init` throws (e.g. the best-effort timeout below
    // fires, or git errors) the dir must still be drained by cleanup() rather
    // than leaking in the tmp tree.
    tempDirs.push(dir);
    // Best-effort timeout, not a hard 5s ceiling: execFileSync still waits for
    // git to exit after the timeout signals SIGTERM, so a genuinely hung git can
    // delay setup past 5s. It bounds the common Windows hang (issue ba388d01) so
    // the suite fails fast in practice instead of stalling to the outer lane
    // ceiling. A strict bound would need a killable process-tree supervisor.
    execFileSync('git', ['init', '-q'], { cwd: dir, timeout: 5000 });
    return dir;
  }

  function cleanup() {
    while (tempDirs.length > 0) {
      rmrfWithRetry(tempDirs.pop());
    }
  }

  return { makeProjectRoot, cleanup };
}

module.exports = { createKernelProjectRoots, rmrfWithRetry };
