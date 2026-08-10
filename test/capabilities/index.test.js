'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const capabilities = require('../../lib/capabilities');

test('capability package surface exposes model and probe APIs', () => {
  assert.equal(typeof capabilities.createProbeResult, 'function');
  assert.equal(typeof capabilities.computeProbeResultHash, 'function');
  assert.equal(typeof capabilities.probeHarness, 'function');
  assert.equal(typeof capabilities.probeAllHarnesses, 'function');
});
