'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeProbeResultHash, createProbeResult } = require('../../lib/capabilities/model');

test('probe result model binds privacy-safe evidence and excludes observation time from its hash', () => {
  const input = {
    probeRevision: 'probe.v1',
    harnessId: 'fixture',
    status: 'PASS',
    availability: 'AVAILABLE',
    executable: { command: 'fixture', identity: 'a'.repeat(64), version: '1.0.0' },
    capabilities: [{
      id: 'wake_resume',
      available: false,
      status: 'UNAVAILABLE',
      reason: 'PROBED_UNSUPPORTED',
      probe_id: 'fixture.resume.v1',
    }],
  };
  const first = createProbeResult({ ...input, observedAt: '2026-08-11T00:00:00.000Z' });
  const second = createProbeResult({ ...input, observedAt: '2026-08-11T01:00:00.000Z' });

  assert.equal(first.result_hash, second.result_hash);
  assert.equal(first.result_hash, computeProbeResultHash(first));
  assert.equal(Object.isFrozen(first), true);
});
