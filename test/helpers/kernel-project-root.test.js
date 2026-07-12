'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { createKernelProjectRoots } = require('./kernel-project-root');

describe('createKernelProjectRoots helper', () => {
  test('makeProjectRoot creates a throwaway git repo and cleanup drains it', () => {
    const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-krp-ok-');
    const dir = makeProjectRoot();

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);

    cleanup();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('a failed git init still tracks the temp dir so cleanup removes it (no leak)', () => {
    // mkdtempSync creates the dir before git init runs; simulate the Windows
    // git hang/timeout by throwing from execFileSync and assert the already-created
    // dir is still drained by cleanup() rather than leaking in the tmp tree.
    let capturedDir;
    const failingExec = (_command, _args, options) => {
      capturedDir = options.cwd;
      const error = new Error('git init timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    };

    const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-krp-fail-', {
      execFileSync: failingExec,
    });

    expect(() => makeProjectRoot()).toThrow();
    expect(capturedDir).toBeTruthy();
    // The temp dir exists on disk (mkdtempSync ran before the failing git init).
    expect(fs.existsSync(capturedDir)).toBe(true);

    // cleanup() must remove it despite makeProjectRoot throwing — proving the dir
    // was tracked before the git call.
    cleanup();
    expect(fs.existsSync(capturedDir)).toBe(false);
  });

  test('makeProjectRoot passes a bounded (best-effort) timeout to git init', () => {
    const calls = [];
    const recordingExec = (command, args, options) => {
      calls.push({ command, args, options });
    };

    const { makeProjectRoot, cleanup } = createKernelProjectRoots('forge-krp-timeout-', {
      execFileSync: recordingExec,
    });

    try {
      makeProjectRoot();
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('git');
      expect(calls[0].args).toEqual(['init', '-q']);
      expect(calls[0].options.timeout).toBe(5000);
    } finally {
      cleanup();
    }
  });
});
