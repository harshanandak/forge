'use strict';

const fs = require('node:fs');
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

function cleanup() {
  fs.rmSync(VENDOR_ROOT, { force: true, recursive: true });
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
  cleanup();
  try {
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
