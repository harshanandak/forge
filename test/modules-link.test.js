'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detachModulesLink, detachWorktreeModulesLink } = require('../lib/modules-link');

const LINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOSYS', 'UV_EPERM']);

describe('modules-link', () => {
  test('detaches a link without touching the target, and leaves a real directory alone', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-modules-link-'));
    try {
      const target = path.join(tmp, 'shared');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
      const wt = path.join(tmp, 'wt');
      fs.mkdirSync(wt);
      try {
        fs.symlinkSync(target, path.join(wt, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (LINK_ERRORS.has(error.code)) return;
        throw error;
      }

      expect(detachWorktreeModulesLink(wt, fs)).toBe(true);
      expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
      expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('x');

      fs.mkdirSync(path.join(wt, 'node_modules'));
      expect(detachModulesLink(path.join(wt, 'node_modules'), fs)).toBe(false);
      expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20000);

  test('a missing node_modules is a no-op; an undetachable link throws naming node_modules', () => {
    const missing = () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
    expect(detachWorktreeModulesLink('/nowhere', { lstatSync: missing })).toBe(false);

    const lockedLink = {
      lstatSync: () => ({ isSymbolicLink: () => true }),
      unlinkSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; },
    };
    expect(() => detachWorktreeModulesLink('/wt', lockedLink)).toThrow(/node_modules/);
  });
});
