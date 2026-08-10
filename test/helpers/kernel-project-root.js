'use strict';

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

// Per-suite factory: each test file gets isolated Kernel project roots with the
// conventional .git directory used by the store, plus cleanup that drains them.
// `prefix` names the tmp dirs so leaks are attributable.
function createKernelProjectRoots(prefix) {
  const tempDirs = [];

  function makeProjectRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.git'));
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
