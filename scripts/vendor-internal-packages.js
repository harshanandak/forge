'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'lib', '_internal', 'vendor');
const PACKAGE_FILES = {
  contracts: [
    'index.js',
    'src/baseline.js',
    'src/canonical.js',
    'src/definitions.js',
    'src/identity.js',
    'src/schema.js',
    'src/validate.js',
    'contract-baseline.v1.json',
    'compatibility-matrix.v1.json',
    'fixtures',
    'schemas',
  ],
  memory: [
    'index.js',
    'src/authority-provider.js',
    'src/backend-registry.js',
    'src/feedback-intake.js',
    'src/pr-lifecycle-authority.js',
    'src/usage-evidence.js',
  ],
  flow: [
    'index.js',
    'src/bounded-loop.js',
    'src/efficiency-supervisor.js',
    'src/executor.js',
    'src/monitor-durability.js',
    'src/monitor-runtime.js',
    'src/process-lifecycle.js',
    'src/skill-runtime.js',
  ],
};

// npm runs prepack and postpack as separate processes around the archive
// step, and every pack in this checkout shares VENDOR_ROOT. Serialize the whole
// prepack -> postpack window with an O_EXCL lock: prepare acquires it (waiting
// while another pack holds it) and cleanup releases it. Only the holder can be
// inside the window, so cleanup never removes another pack's vendor tree. The
// lock lives outside the package tree so it can never be archived.
const LOCK_PATH = path.join(
  os.tmpdir(),
  `forge-vendor-${crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 16)}.lock`,
);
const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 100;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(LOCK_PATH, `${process.pid} ${ROOT}
`, { flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${LOCK_WAIT_MS}ms waiting for another pack of ${ROOT} to finish. ` +
          `If no npm pack/publish is running, remove the stale lock: ${LOCK_PATH}`,
      );
    }
    sleep(LOCK_POLL_MS);
  }
}

function releaseLock() {
  fs.rmSync(LOCK_PATH, { force: true });
}

function removeVendor() {
  fs.rmSync(VENDOR_ROOT, { force: true, recursive: true });
}

function cleanup() {
  removeVendor();
  releaseLock();
}

function rewriteInternalImports(target) {
  if (path.extname(target) !== '.js') return;
  const source = fs.readFileSync(target, 'utf8');
  const rewritten = source
    .replaceAll("require('@forge/contracts')", "require('#forge/contracts')")
    .replaceAll('require("@forge/contracts")', 'require("#forge/contracts")');
  if (rewritten !== source) fs.writeFileSync(target, rewritten);
}

function copyEntry(source, target) {
  fs.cpSync(source, target, { recursive: true });
  if (fs.statSync(target).isDirectory()) {
    for (const entry of fs.readdirSync(target, { recursive: true })) {
      const child = path.join(target, entry);
      if (fs.statSync(child).isFile()) rewriteInternalImports(child);
    }
  } else {
    rewriteInternalImports(target);
  }
}

function prepare() {
  acquireLock();
  try {
    removeVendor();
    for (const [name, files] of Object.entries(PACKAGE_FILES)) {
      const sourceRoot = path.join(ROOT, 'packages', name);
      const targetRoot = path.join(VENDOR_ROOT, name);
      for (const file of files) copyEntry(path.join(sourceRoot, file), path.join(targetRoot, file));
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}

const action = process.argv[2];
if (action === 'prepare') prepare();
else if (action === 'cleanup') cleanup();
else throw new Error('Expected prepare or cleanup');
