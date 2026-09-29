'use strict';

const { test, expect } = require('bun:test');
const packageJson = require('../package.json');

test('keeps transparent routing opt-in instead of shadowing gh at package install time', () => {
  expect(packageJson.bin.gh).toBeUndefined();
  expect(packageJson.bin['forge-git-credential']).toBeUndefined();
  expect(packageJson.bin.forge).toBe('bin/forge.js');
});
