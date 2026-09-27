'use strict';

const { expect, test } = require('bun:test');
const { loadInternal } = require('../../lib/_internal/load-internal');

test('unknown internal package names fail closed', () => {
  expect(() => loadInternal('not-present')).toThrow('Unknown internal package: not-present');
});
