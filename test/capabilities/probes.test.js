'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CAPABILITY_IDS, probeHarness } = require('../../lib/capabilities/probes');
const { successfulExecutor } = require('../capability/fixtures');

test('version-bound harness probe returns one executable receipt per capability', async () => {
  const result = await probeHarness({
    harness: 'codex',
    execute: successfulExecutor(),
    observedAt: '2026-08-11T00:00:00.000Z',
  });

  assert.equal(result.status, 'PASS');
  assert.equal(result.executable.version, '0.147.0');
  assert.deepEqual(result.capabilities.map((capability) => capability.id), [...CAPABILITY_IDS].sort());
});
