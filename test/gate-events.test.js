'use strict';

// Direct unit coverage for the gate-events kernel-path module (the command-level
// integration lives in test/commands/gate-events.test.js). Gate approvals are pure
// appends to the issue's kernel event stream: durable, queryable, idempotent, and
// actor-attributed.

const { describe, expect, test } = require('bun:test');

const {
  GATE_APPROVED_EVENT,
  GATE_REJECTED_EVENT,
  gateIdempotencyKey,
  parseGateEvent,
  recordGateEvent,
  listGateEvents,
  isGateApproved,
} = require('../lib/gate-events');
const { buildMigratedKernelIssueDeps } = require('../lib/kernel/cli-broker-factory');

const UNUSED_ROOT = '/unused-because-deps-are-injected';

async function freshKernel() {
  return buildMigratedKernelIssueDeps({ databasePath: ':memory:' });
}

async function seedIssue(deps, id) {
  const res = await deps.kernelBroker.runIssueOperation(
    'create',
    ['--id', id, '--title', 'unit', '--type', 'task'],
    { actor: 'seed', origin: 'test' },
  );
  expect(res.ok).toBe(true);
  return res.data.id;
}

function deps(kernel) {
  return { kernelBroker: kernel.kernelBroker, kernelDriver: kernel.kernelDriver };
}

describe('gate-events module', () => {
  test('gateIdempotencyKey scopes to event+issue+gate+actor', () => {
    expect(gateIdempotencyKey(GATE_APPROVED_EVENT, 'i1', 'gate.merge', 'alice'))
      .toBe('gate.approved:i1:gate.merge:alice');
  });

  test('parseGateEvent extracts gate/actor/reason from the stored row', () => {
    const view = parseGateEvent({
      event_type: GATE_REJECTED_EVENT,
      actor: 'bob',
      created_at: '2026-07-04T00:00:00.000Z',
      payload_json: JSON.stringify({ gate: 'gate.merge', actor: 'bob', reason: 'no' }),
    });
    expect(view).toEqual({
      event_type: 'gate.rejected',
      gate: 'gate.merge',
      actor: 'bob',
      created_at: '2026-07-04T00:00:00.000Z',
      reason: 'no',
    });
  });

  test('parseGateEvent tolerates a missing/invalid payload', () => {
    const view = parseGateEvent({ event_type: 'gate.approved', actor: 'x', created_at: 't', payload_json: 'not-json' });
    expect(view.gate).toBeUndefined();
    expect(view.reason).toBeUndefined();
  });

  test('recordGateEvent appends a gate.approved event with the resolved actor', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'unit-approve');

    const result = await recordGateEvent(UNUSED_ROOT, {
      issueId: issue,
      gateId: 'gate.plan-approval',
      decision: 'approved',
      env: { FORGE_ACTOR: 'alice' },
      deps: deps(kernel),
    });

    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.actor).toBe('alice');
    expect(result.event.event_type).toBe(GATE_APPROVED_EVENT);
    expect(result.event.gate).toBe('gate.plan-approval');
  });

  test('recordGateEvent is idempotent per issue+gate+actor+decision', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'unit-idem');
    const params = {
      issueId: issue,
      gateId: 'gate.plan-approval',
      decision: 'approved',
      env: { FORGE_ACTOR: 'alice' },
      deps: deps(kernel),
    };

    const first = await recordGateEvent(UNUSED_ROOT, params);
    const second = await recordGateEvent(UNUSED_ROOT, params);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const events = await listGateEvents(UNUSED_ROOT, issue, { deps: deps(kernel) });
    const approvals = events.filter(e => e.event_type === GATE_APPROVED_EVENT && e.gate === 'gate.plan-approval');
    expect(approvals).toHaveLength(1);
  });

  test('recordGateEvent reports a missing issue instead of writing an orphan event', async () => {
    const kernel = await freshKernel();
    const result = await recordGateEvent(UNUSED_ROOT, {
      issueId: 'ghost',
      gateId: 'gate.plan-approval',
      decision: 'approved',
      env: { FORGE_ACTOR: 'alice' },
      deps: deps(kernel),
    });
    expect(result.ok).toBe(false);
    expect(result.issueMissing).toBe(true);
  });

  test('recordGateEvent records a rejection with its reason', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'unit-reject');

    const result = await recordGateEvent(UNUSED_ROOT, {
      issueId: issue,
      gateId: 'gate.merge',
      decision: 'rejected',
      reason: 'needs rework',
      env: { FORGE_ACTOR: 'bob' },
      deps: deps(kernel),
    });
    expect(result.ok).toBe(true);
    expect(result.event.event_type).toBe(GATE_REJECTED_EVENT);
    expect(result.event.reason).toBe('needs rework');
  });

  test('isGateApproved reflects only a matching gate.approved event', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'unit-approved-check');

    expect(await isGateApproved(UNUSED_ROOT, issue, 'gate.intent', { deps: deps(kernel) })).toBe(false);

    await recordGateEvent(UNUSED_ROOT, {
      issueId: issue,
      gateId: 'gate.intent',
      decision: 'approved',
      env: { FORGE_ACTOR: 'alice' },
      deps: deps(kernel),
    });

    expect(await isGateApproved(UNUSED_ROOT, issue, 'gate.intent', { deps: deps(kernel) })).toBe(true);
    // A different gate stays unapproved.
    expect(await isGateApproved(UNUSED_ROOT, issue, 'gate.merge', { deps: deps(kernel) })).toBe(false);
  });
});

// Driver-lifecycle invariant (same class as the grounding fix, kernel issue
// e62e4bde): a kernel gate-events BUILDS itself must be closed (an unclosed
// SQLite handle locks the DB dir on Windows -> rmSync EBUSY); an INJECTED/shared
// kernel must NEVER be closed (the caller owns it). Cross-platform: counts close().
describe('gate-events kernel-driver lifecycle', () => {
  // Wrap a driver so its methods still hit the real :memory: kernel, but close()
  // is counted instead of actually closing (so the shared db stays usable).
  function withCloseCounter(driver) {
    const counter = { count: 0 };
    const wrapped = {};
    for (const key of Object.keys(driver)) {
      wrapped[key] = typeof driver[key] === 'function' ? driver[key].bind(driver) : driver[key];
    }
    wrapped.close = () => { counter.count += 1; };
    return { driver: wrapped, counter };
  }

  test('an INJECTED/shared kernel is NEVER closed', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'gate-life-injected');
    const { driver, counter } = withCloseCounter(kernel.kernelDriver);
    const injected = { kernelBroker: kernel.kernelBroker, kernelDriver: driver };

    await recordGateEvent(UNUSED_ROOT, {
      issueId: issue, gateId: 'gate.merge', decision: 'approved', env: { FORGE_ACTOR: 'a' }, deps: injected,
    });
    await listGateEvents(UNUSED_ROOT, issue, { deps: injected });

    expect(counter.count).toBe(0);
  });

  test('a kernel the module BUILT itself is closed after record and list', async () => {
    const kernel = await freshKernel();
    const issue = await seedIssue(kernel, 'gate-life-owned');
    const { driver, counter } = withCloseCounter(kernel.kernelDriver);
    const built = { kernelBuilder: async () => ({ kernelBroker: kernel.kernelBroker, kernelDriver: driver }) };

    await recordGateEvent(UNUSED_ROOT, {
      issueId: issue, gateId: 'gate.merge', decision: 'approved', env: { FORGE_ACTOR: 'a' }, deps: built,
    });
    expect(counter.count).toBe(1);

    await listGateEvents(UNUSED_ROOT, issue, { deps: built });
    expect(counter.count).toBe(2);
  });

  test('the built kernel is closed even when the issue is missing', async () => {
    const kernel = await freshKernel();
    const { driver, counter } = withCloseCounter(kernel.kernelDriver);
    const built = { kernelBuilder: async () => ({ kernelBroker: kernel.kernelBroker, kernelDriver: driver }) };

    const result = await recordGateEvent(UNUSED_ROOT, {
      issueId: 'ghost', gateId: 'gate.merge', decision: 'approved', env: { FORGE_ACTOR: 'a' }, deps: built,
    });
    expect(result.issueMissing).toBe(true);
    expect(counter.count).toBe(1); // finally still closes on the early return
  });
});
