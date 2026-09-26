'use strict';

const { expect, test } = require('bun:test');
const { loadInternal } = require('../../lib/_internal/load-internal');

test('missing workspace targets fall through to the generated vendor path', () => {
  expect(() => loadInternal('not-present')).toThrow('vendor');
});
