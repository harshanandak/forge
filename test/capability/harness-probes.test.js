'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPABILITY_IDS,
  HARNESS_IDS,
  PROBE_REVISION,
  computeProbeResultHash,
  getHarnessProbeSpec,
  probeAllHarnesses,
  probeHarness,
} = require('../../lib/capabilities');
const {
  EXECUTABLE_IDENTITIES,
  SUPPORT_OUTPUT,
  VERSIONS,
  successfulExecutor,
} = require('./fixtures');

test('every supported harness uses bounded executable behavior probes', async () => {
  const requests = [];
  const results = await probeAllHarnesses({
    execute: async (request) => {
      requests.push(request);
      return successfulExecutor()(request);
    },
    timeoutMs: 250,
    maxOutputBytes: 2048,
  });

  assert.deepEqual(results.map((result) => result.harness_id), HARNESS_IDS);
  for (const result of results) {
    assert.equal(result.probe_revision, PROBE_REVISION);
    assert.equal(result.status, 'PASS');
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.executable.identity, EXECUTABLE_IDENTITIES[result.harness_id]);
    assert.equal(result.capabilities.length, CAPABILITY_IDS.length);
    assert.ok(result.capabilities.some((capability) => capability.available));
    assert.match(result.result_hash, /^[0-9a-f]{64}$/);
    assert.equal(result.result_hash, computeProbeResultHash(result));
  }

  assert.ok(requests.every((request) => request.timeoutMs === 250));
  assert.ok(requests.every((request) => request.maxOutputBytes === 2048));
  assert.ok(requests.every((request) => request.sideEffectFree === true));
  assert.ok(requests.every((request) => Object.isFrozen(request.args)));
});

test('product name and version never imply a capability', async () => {
  const result = await probeHarness({
    harness: 'codex',
    execute: async (request) => ({
      exitCode: 0,
      stdout: request.kind === 'version' ? VERSIONS.codex : 'Usage: codex command',
      stderr: '',
      executableIdentity: EXECUTABLE_IDENTITIES.codex,
    }),
  });

  assert.equal(result.status, 'PASS');
  assert.ok(result.capabilities.every((capability) => capability.available === false));
  assert.ok(result.capabilities.every((capability) => capability.status === 'UNAVAILABLE'));
  assert.ok(result.capabilities.every((capability) => capability.reason === 'PROBED_UNSUPPORTED'));
});

test('absent executables fail closed without attempting behavior probes', async () => {
  const requests = [];
  const result = await probeHarness({
    harness: 'cursor',
    execute: async (request) => {
      requests.push(request);
      return { exitCode: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, 'version');
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.availability, 'UNAVAILABLE');
  assert.equal(result.executable.version, null);
  assert.ok(result.capabilities.every((capability) => capability.status === 'INCOMPLETE'));
  assert.ok(result.capabilities.every((capability) => capability.reason === 'EXECUTABLE_UNAVAILABLE'));
});

test('timeouts are bounded and reported INCOMPLETE', async () => {
  const result = await probeHarness({
    harness: 'hermes',
    timeoutMs: 10,
    execute: async (request) => {
      if (request.kind === 'version') return successfulExecutor()(request);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return successfulExecutor()(request);
    },
  });

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.availability, 'AVAILABLE');
  assert.ok(result.capabilities.every((capability) => capability.status === 'INCOMPLETE'));
  assert.ok(result.capabilities.every((capability) => capability.reason === 'PROBE_TIMEOUT'));
});

test('malformed version output fails closed', async () => {
  const result = await probeHarness({
    harness: 'claude',
    execute: successfulExecutor({ stdout: 'latest release' }),
  });

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.availability, 'UNAVAILABLE');
  assert.ok(result.capabilities.every((capability) => capability.reason === 'MALFORMED_VERSION'));
});

test('hostile output is neither retained nor hashed as evidence', async () => {
  const secret = 'ghp_123456789012345678901234567890';
  const privatePath = 'C:\\Users\\victim\\private';
  const result = await probeHarness({
    harness: 'codex',
    execute: async (request) => ({
      exitCode: 0,
      stdout: request.kind === 'version'
        ? VERSIONS.codex
        : `${SUPPORT_OUTPUT.codex}\nTOKEN=${secret}\n${privatePath}\n\u001b[31mred`,
      stderr: '',
      executableIdentity: EXECUTABLE_IDENTITIES.codex,
    }),
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.capabilities.every((capability) => capability.status === 'INCOMPLETE'));
  assert.ok(result.capabilities.every((capability) => capability.reason === 'HOSTILE_OUTPUT'));
  assert.doesNotMatch(serialized, /ghp_|victim|TOKEN=|red/);
  assert.equal(serialized.includes(String.fromCharCode(27)), false);
});

test('secret detectors fail closed without overmatching benign controls', async () => {
  const executorWithBehaviorOutput = (output) => async (request) => {
    const response = await successfulExecutor()(request);
    return request.kind === 'version' ? response : { ...response, stdout: output };
  };
  const secretOutputs = [
    `ghp_${'a'.repeat(20)}`,
    `sk-live-${'b'.repeat(16)}`,
    `api_key=${'c'.repeat(8)}`,
  ];
  for (const secret of secretOutputs) {
    const result = await probeHarness({
      harness: 'codex',
      execute: executorWithBehaviorOutput(`${SUPPORT_OUTPUT.codex}\n${secret}`),
    });
    assert.equal(result.status, 'INCOMPLETE');
    assert.ok(result.capabilities.every((capability) => capability.reason === 'HOSTILE_OUTPUT'));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }

  const benign = await probeHarness({
    harness: 'codex',
    execute: executorWithBehaviorOutput(
      `${SUPPORT_OUTPUT.codex}\nghp_short sk-live-short api_key=public`
    ),
  });
  assert.equal(benign.status, 'PASS');
});

test('oversized output fails closed', async () => {
  const result = await probeHarness({
    harness: 'claude',
    maxOutputBytes: 32,
    execute: successfulExecutor(),
  });
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.capabilities.every((capability) => capability.reason === 'OUTPUT_LIMIT'));
});

test('executable identity changes fail closed', async () => {
  const result = await probeHarness({
    harness: 'cursor',
    execute: async (request) => ({
      exitCode: 0,
      stdout: request.kind === 'version' ? VERSIONS.cursor : SUPPORT_OUTPUT.cursor,
      stderr: '',
      executableIdentity: request.kind === 'version'
        ? EXECUTABLE_IDENTITIES.cursor
        : '9'.repeat(64),
    }),
  });
  assert.equal(result.status, 'INCOMPLETE');
  assert.ok(result.capabilities.every((capability) => capability.reason === 'EXECUTABLE_IDENTITY_CHANGED'));
});

test('result hashes are deterministic and exclude observation time', async () => {
  const first = await probeHarness({
    harness: 'hermes',
    execute: successfulExecutor(),
    observedAt: '2026-08-11T00:00:00.000Z',
  });
  const second = await probeHarness({
    harness: 'hermes',
    execute: successfulExecutor(),
    observedAt: '2026-08-11T01:00:00.000Z',
  });

  assert.notEqual(first.observed_at, second.observed_at);
  assert.equal(first.result_hash, second.result_hash);
  assert.equal(first.result_hash, '4fb765aca9e3e5ad1c3a9ca36d17783942e64e2731a0494b16c691eecc8a0c8e');
  assert.deepEqual(getHarnessProbeSpec('hermes').capabilities.map((item) => item.id), CAPABILITY_IDS);
});

test('unknown harnesses are rejected before execution', async () => {
  let called = false;
  await assert.rejects(
    probeHarness({
      harness: 'made-up-product',
      execute: async () => {
        called = true;
        return {};
      },
    }),
    /Unsupported harness/,
  );
  assert.equal(called, false);
});
