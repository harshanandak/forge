'use strict';

const { expect, test } = require('bun:test');

test('#forge/flow uses the repository workspace', () => {
  expect(require('#forge/flow')).toBe(require('../../packages/flow'));
});
