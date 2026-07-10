'use strict';

const { execFileSync } = require('node:child_process');
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
function createKernelProjectRoots(prefix) {
  const tempDirs = [];

  function makeProjectRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    tempDirs.push(dir);
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
