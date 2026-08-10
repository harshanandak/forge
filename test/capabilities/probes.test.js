'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPABILITY_IDS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  probeHarness,
} = require('../../lib/capabilities/probes');
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

test('probe defaults and exact maximum boundaries remain bounded', async () => {
  const defaultRequests = [];
  await probeHarness({
    harness: 'codex',
    execute: async (request) => {
      defaultRequests.push(request);
      return successfulExecutor()(request);
    },
  });
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= MAX_TIMEOUT_MS);
  assert.ok(DEFAULT_MAX_OUTPUT_BYTES > 0 && DEFAULT_MAX_OUTPUT_BYTES <= MAX_OUTPUT_BYTES);
  assert.ok(defaultRequests.every((request) => request.timeoutMs === DEFAULT_TIMEOUT_MS));
  assert.ok(defaultRequests.every((request) => request.maxOutputBytes === DEFAULT_MAX_OUTPUT_BYTES));

  const boundaryRequests = [];
  await probeHarness({
    harness: 'codex',
    timeoutMs: MAX_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    execute: async (request) => {
      boundaryRequests.push(request);
      return successfulExecutor()(request);
    },
  });
  assert.ok(boundaryRequests.every((request) => request.timeoutMs === MAX_TIMEOUT_MS));
  assert.ok(boundaryRequests.every((request) => request.maxOutputBytes === MAX_OUTPUT_BYTES));
});

test('invalid and hostile bounds are rejected before executor invocation', async () => {
  for (const [field, values] of [
    ['timeoutMs', [0, -1, 1.5, MAX_TIMEOUT_MS + 1, 2147483647]],
    ['maxOutputBytes', [0, -1, 1.5, MAX_OUTPUT_BYTES + 1, 2147483647]],
  ]) {
    for (const value of values) {
      let called = false;
      await assert.rejects(
        probeHarness({
          harness: 'codex',
          [field]: value,
          execute: async () => {
            called = true;
            return successfulExecutor()({ harness: 'codex', kind: 'version' });
          },
        }),
        new RegExp(`${field} must be an integer between 1 and`),
      );
      assert.equal(called, false);
    }
  }
});
