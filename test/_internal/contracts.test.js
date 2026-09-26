'use strict';

const { expect, test } = require('bun:test');

test('#forge/contracts uses the repository workspace', () => {
  expect(require('#forge/contracts')).toBe(require('../../packages/contracts'));
});
