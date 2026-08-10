'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { createKernelProjectRoots } = require('./kernel-project-root');

describe('createKernelProjectRoots helper', () => {
  test('makeProjectRoot creates a conventional .git directory and cleanup drains it', () => {
    const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-krp-ok-');
    const dir = makeProjectRoot();

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(path.join(dir, '.git')).isDirectory()).toBe(true);

    cleanup();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('makeProjectRoot never spawns git', () => {
    const helperSource = fs.readFileSync(require.resolve('./kernel-project-root'), 'utf8');
    expect(helperSource).not.toMatch(/node:child_process|execFileSync|spawnSync/);

    const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-krp-no-spawn-');

    try {
      const dir = makeProjectRoot();
      expect(fs.statSync(path.join(dir, '.git')).isDirectory()).toBe(true);
    } finally {
      cleanup();
    }
  });
});
