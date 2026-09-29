'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { expect, test } = require('bun:test');

const ROOT = path.join(__dirname, '..');

test('validate:yaml runs under Bun and fails when a matching path cannot be read', () => {
  const probeRoot = path.join(ROOT, `.yaml-validation-${process.pid}`);
  const unreadablePath = path.join(probeRoot, 'unreadable.yaml');

  try {
    const clean = spawnSync('bun', ['run', 'validate:yaml'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
    });
    expect(clean.status, clean.stderr).toBe(0);

    fs.mkdirSync(probeRoot, { recursive: true });
    fs.symlinkSync('missing.yaml', unreadablePath, 'file');
    const unreadable = spawnSync('bun', ['run', 'validate:yaml'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
    });
    expect(unreadable.status).not.toBe(0);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}, 30000);
