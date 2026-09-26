'use strict';

const { expect, test } = require('bun:test');

test('#forge/memory uses the repository workspace', () => {
  expect(require('#forge/memory')).toBe(require('../../packages/memory'));
});
